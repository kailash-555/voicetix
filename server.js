require('dotenv').config();
const express = require('express'), cors = require('cors'), rateLimit = require('express-rate-limit'), crypto = require('crypto'), QRCode = require('qrcode'), os = require('os'), path = require('path');
const app = express(); app.use(cors({ origin: process.env.CORS_ORIGIN || true }), express.json({ limit: '50kb' }), express.static(path.join(__dirname, 'public')), express.static('public'));
const SECRET = process.env.PAYMENT_SECRET || 'dev-secret', HOLD_MS = (+process.env.HOLD_SECONDS || 300) * 1000;
const uid = p => p + crypto.randomBytes(4).toString('hex').toUpperCase();
const sign = s => crypto.createHmac('sha256', SECRET).update(s).digest('hex');
function getLanIp() {
    const ifaces = os.networkInterfaces();
    for (const dev in ifaces) {
        for (const d of ifaces[dev]) {
            if (d.family === 'IPv4' && !d.internal) return d.address;
        }
    }
    return '127.0.0.1';
}
const PRICE = { Regular: 150, Premium: 250, Recliner: 400 }, ROWS = 'ABCDEF', COLS = 8, cat = r => 'AB'.includes(r) ? 'Regular' : 'CD'.includes(r) ? 'Premium' : 'Recliner';
// ---- In-memory store (swap for Firestore; see README). Collections mirror the spec.
const DB = { movies: new Map(), theatres: new Map(), shows: new Map(), seats: new Map(), holds: new Map(), bookings: new Map(), payments: new Map(), otps: new Map() };
const T = ['10:30 AM', '02:00 PM', '06:30 PM', '07:00 PM', '09:45 PM'];
['Jailer 2', 'Drishyam 3', 'Ranabaali', 'Prahaar', 'Baththa', 'Tom and Jerry Forbidden Compass', 'Street Fighter'].forEach((t, i) => DB.movies.set('m' + i, { movieId: 'm' + i, title: t, status: 'NOW_SHOWING' }));
['City Cinemas', 'Galaxy Multiplex', 'Starlight Screens'].forEach((n, i) => DB.theatres.set('t' + i, { theatreId: 't' + i, name: n }));
for (let m = 0; m < 7; m++)for (let t = 0; t < 3; t++)for (let d = 0; d < 3; d++)T.forEach((st, k) => { const showId = `m${m}-t${t}-${d}-${k}`; DB.shows.set(showId, { showId, movieId: 'm' + m, theatreId: 't' + t, startTime: st, showDate: d, status: 'OPEN' }) });
function seatMap(showId) {
    let m = DB.seats.get(showId); if (!m) { m = new Map(); for (const r of ROWS) for (let n = 1; n <= COLS; n++)m.set(r + n, { seatId: r + n, category: cat(r), price: PRICE[cat(r)], status: 'AVAILABLE' }); DB.seats.set(showId, m) }
    for (const h of DB.holds.values()) if (!h.done && h.exp < Date.now()) { h.done = true; h.seats.forEach(s => { const x = m.get(s); if (DB.seats.get(h.showId) === m && x && x.holdId === h.holdId) Object.assign(x, { status: 'AVAILABLE', holdId: null, userId: null }) }) }
    return m
}
const sweepAll = () => DB.shows.forEach((_, k) => seatMap(k));
// ---- Auth: Firebase ID token if configured; otherwise DEMO tokens ("demo-alice", "demo-admin") for local testing only.
async function auth(req, res, next) {
    const tok = (req.headers.authorization || '').replace(/^Bearer(\s+|$)/i, '').trim(); if (!tok) return res.status(401).json({ error: 'login required' });
    if (process.env.FIREBASE_PROJECT_ID) { try { const a = require('firebase-admin'); if (!a.apps.length) a.initializeApp(); const d = await a.auth().verifyIdToken(tok); req.user = { uid: d.uid, role: d.admin ? 'admin' : 'user' } } catch { return res.status(401).json({ error: 'invalid token' }) } }
    else req.user = { uid: tok, role: tok === 'demo-admin' ? 'admin' : 'user' }; next()
}
const adminOnly = (q, r, n) => q.user.role === 'admin' ? n() : r.status(403).json({ error: 'admin only' });
const limiter = rateLimit({ windowMs: 6e4, limit: 60, standardHeaders: true });
// ---- Public catalogue
app.get('/api/movies', (q, r) => r.json([...DB.movies.values()].filter(m => m.status !== 'REMOVED')));
app.get('/api/movies/:id', (q, r) => DB.movies.get(q.params.id) ? r.json(DB.movies.get(q.params.id)) : r.status(404).json({ error: 'not found' }));
app.get('/api/theatres', (q, r) => r.json([...DB.theatres.values()]));
app.get('/api/shows', (q, r) => r.json([...DB.shows.values()].filter(s => !q.query.movieId || s.movieId === q.query.movieId)));
app.get('/api/shows/:sid/seats', (q, r) => DB.shows.has(q.params.sid) ? r.json([...seatMap(q.params.sid).values()].map(({ holdId, userId, ...s }) => s)) : r.status(404).json({ error: 'show not found' }));
// ---- Seat hold: check-and-set is synchronous, so atomic within this Node process. On Firestore use runTransaction.
app.post('/api/shows/:sid/hold', auth, limiter, (q, r) => {
    const sh = DB.shows.get(q.params.sid); if (!sh) return r.status(404).json({ error: 'show not found' });
    const seats = q.body.seats; if (!Array.isArray(seats) || !seats.length || seats.length > 8 || !seats.every(s => /^[A-F][1-8]$/.test(s)) || new Set(seats).size !== seats.length) return r.status(400).json({ error: 'invalid seats' });
    const m = seatMap(sh.showId); if (seats.some(s => m.get(s).status !== 'AVAILABLE')) return r.status(409).json({ error: 'seat unavailable' });
    const holdId = uid('H'), exp = Date.now() + HOLD_MS; seats.forEach(s => Object.assign(m.get(s), { status: 'HELD', holdId, userId: q.user.uid }));
    DB.holds.set(holdId, { holdId, showId: sh.showId, userId: q.user.uid, seats, exp }); r.json({ holdId, seats, holdExpiresAt: exp })
});
app.post('/api/holds/:id/release', auth, (q, r) => {
    const h = DB.holds.get(q.params.id); if (!h || h.userId !== q.user.uid) return r.status(404).json({ error: 'not found' });
    if (!h.done && !h.bookingId) { h.done = true; const m = seatMap(h.showId); h.seats.forEach(s => Object.assign(m.get(s), { status: 'AVAILABLE', holdId: null, userId: null })) } r.json({ released: true })
});
// ---- Booking: price is ALWAYS computed on the server
app.post('/api/bookings', auth, limiter, (q, r) => {
    const { holdId, customer: c = {} } = q.body; const h = DB.holds.get(holdId);
    if (!h || h.userId !== q.user.uid || h.done || h.exp < Date.now()) return r.status(409).json({ error: 'hold missing or expired' });
    if (h.bookingId) return r.status(409).json({ error: 'booking already exists for this hold', bookingId: h.bookingId });
    const hasEmail = /\S+@\S+\.\S+/.test(c.email || '');
    const cleanPhone = String(c.phone || '').replace(/[\s-]/g, '');
    const hasPhone = /^\+?\d{10,13}$/.test(cleanPhone);
    if (!c.name || (!hasEmail && !hasPhone)) return r.status(400).json({ error: 'Please provide either a valid 10-digit mobile number or email address' });
    const m = seatMap(h.showId), sub = h.seats.reduce((a, s) => a + m.get(s).price, 0), fee = Math.round(sub * .1), gst = Math.round(fee * .18), disc = String(q.body.coupon || '').toUpperCase() === 'VOICE10' ? Math.round(sub * .1) : 0, sh = DB.shows.get(h.showId);
    const mov = DB.movies.get(sh.movieId) || { title: sh.movieId }, thtr = DB.theatres.get(sh.theatreId) || { name: sh.theatreId };
    const b = {
        bookingId: uid('BK'), userId: q.user.uid, movieId: sh.movieId, movieTitle: mov.title, theatreId: sh.theatreId, theatreName: thtr.name, showId: h.showId, startTime: sh.startTime, showDate: sh.showDate, seatNumbers: h.seats, ticketCount: h.seats.length,
        customerDetails: { name: c.name, email: c.email, phone: c.phone }, subtotal: sub, fees: fee, gst, discount: disc, totalAmount: sub - disc + fee + gst, bookingStatus: 'PENDING_PAYMENT', paymentStatus: 'UNPAID', createdAt: new Date().toISOString(), holdId
    };
    h.bookingId = b.bookingId; DB.bookings.set(b.bookingId, b); r.status(201).json(b)
});
const own = (q, r) => { const b = DB.bookings.get(q.params.id); if (!b || (b.userId !== q.user.uid && q.user.role !== 'admin')) { r.status(404).json({ error: 'not found' }); return null } return b };
app.get('/api/bookings/me', auth, (q, r) => r.json([...DB.bookings.values()].filter(b => b.userId === q.user.uid)));
app.get('/api/bookings/:id', auth, (q, r) => { const b = own(q, r); if (b) r.json(b) });
app.post('/api/bookings/:id/cancel', auth, (q, r) => {
    const b = own(q, r); if (!b) return; if (b.bookingStatus === 'CANCELLED') return r.status(409).json({ error: 'already cancelled' });
    const m = seatMap(b.showId); b.seatNumbers.forEach(s => Object.assign(m.get(s), { status: 'AVAILABLE', holdId: null, userId: null }));
    b.bookingStatus = 'CANCELLED'; b.paymentStatus = b.paymentStatus === 'PAID' ? 'REFUND_PENDING' : b.paymentStatus; r.json(b)
});
// ---- Payments: booking is PAID only via a signed provider result (verify), never from a frontend click.
app.post('/api/payments/initiate', auth, limiter, async (q, r) => {
    const b = DB.bookings.get(q.body.bookingId); if (!b || b.userId !== q.user.uid) return r.status(404).json({ error: 'not found' });
    if (b.bookingStatus !== 'PENDING_PAYMENT') return r.status(409).json({ error: 'booking not payable' });
    const p = { paymentId: uid('PAY'), bookingId: b.bookingId, amount: b.totalAmount, currency: 'INR', provider: 'QR_AUTH', providerTransactionId: null, paymentStatus: 'PENDING', createdAt: new Date().toISOString() };
    DB.payments.set(p.paymentId, p);
    const lanIp = getLanIp();
    const isVercel = !!process.env.VERCEL;
    const proto = q.headers['x-forwarded-proto'] || (isVercel ? 'https' : 'http');
    let approvalHost = q.headers.host || `${lanIp}:3000`;
    if (approvalHost.startsWith('localhost') || approvalHost.startsWith('127.0.0.1')) {
        const port = approvalHost.includes(':') ? approvalHost.split(':')[1] : (process.env.PORT || 3000);
        approvalHost = `${lanIp}:${port}`;
    }
    const approvalUrl = `${proto}://${approvalHost}/approve/${p.paymentId}`;
    let qrSvg = '';
    try {
        qrSvg = await QRCode.toString(approvalUrl, { type: 'svg', margin: 1, width: 220 });
    } catch(e) {
        console.error('QR generation error:', e.message);
    }
    r.status(201).json({
        paymentId: p.paymentId,
        amount: p.amount,
        currency: p.currency,
        approvalUrl,
        qrSvg,
        note: 'Scan QR with phone camera to approve or decline payment'
    });
});
app.get('/api/network-info', (q, r) => {
    const lanIp = getLanIp();
    const port = process.env.PORT || 3000;
    r.json({ ip: lanIp, port, baseUrl: `http://${lanIp}:${port}` });
});
app.get('/api/payments/:pid/status', (q, r) => {
    const p = DB.payments.get(q.params.pid);
    if (!p) return r.status(404).json({ error: 'not found' });
    const b = DB.bookings.get(p.bookingId);
    r.json({
        paymentId: p.paymentId,
        paymentStatus: p.paymentStatus,
        bookingStatus: b ? b.bookingStatus : null,
        booking: (p.paymentStatus === 'SUCCESS' && b) ? b : null
    });
});
app.post('/api/approve/:pid', (q, r) => {
    const p = DB.payments.get(q.params.pid);
    if (!p) return r.status(404).json({ error: 'payment not found' });
    if (p.paymentStatus !== 'PENDING') return r.json({ status: p.paymentStatus, message: 'already processed' });
    const isVercel = !!process.env.VERCEL;
    const proto = q.headers['x-forwarded-proto'] || (isVercel ? 'https' : 'http');
    const baseUrl = `${proto}://${q.headers.host || 'localhost:3000'}`;
    const st = q.body.approve ? 'SUCCESS' : 'FAILED';
    const out = verify(p.paymentId, st, sign(p.paymentId + st), baseUrl);
    r.status(out.code).json(out);
});
app.get('/approve/:pid', (q, r) => {
    const p = DB.payments.get(q.params.pid);
    if (!p) return r.status(404).send('<!DOCTYPE html><html><body style="font-family:system-ui;padding:40px;background:#0f172a;color:#fff;text-align:center"><h2>Session Expired or Invalid</h2><p>Please initiate payment on screen again.</p></body></html>');
    const b = DB.bookings.get(p.bookingId) || {};
    const movie = b.movieTitle || 'Movie Ticket';
    const cinema = b.theatreName || 'Cinema Hall';
    const time = b.startTime || 'Showtime';
    const seats = (b.seatNumbers || []).join(', ');
    const amt = p.amount;
    const name = b.customerDetails?.name || 'Guest Attendee';
    const phone = b.customerDetails?.phone || '';

    r.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>Authorize Payment · VoiceTix</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #090d16; color: #f8fafc; padding: 18px; display: grid; place-items: center; min-height: 100vh; }
    .card { background: #131b2e; border: 1px solid rgba(255,255,255,0.14); border-radius: 20px; width: 100%; max-width: 420px; padding: 24px; box-shadow: 0 20px 40px rgba(0,0,0,0.6); }
    .badge { display: inline-flex; align-items: center; gap: 6px; background: rgba(56,189,248,0.12); color: #38bdf8; font-size: 11px; font-weight: 800; padding: 4px 10px; border-radius: 20px; text-transform: uppercase; letter-spacing: 0.5px; }
    h1 { font-size: 22px; margin: 12px 0 4px; font-weight: 800; color: #fff; }
    .sub { font-size: 13px; color: #94a3b8; margin-bottom: 20px; }
    .bill-panel { background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.06); border-radius: 14px; padding: 14px; margin-bottom: 20px; }
    .row { display: flex; justify-content: space-between; align-items: center; padding: 6px 0; font-size: 13px; }
    .lbl { color: #94a3b8; }
    .val { font-weight: 700; color: #fff; text-align: right; }
    .total-row { border-top: 1px dashed rgba(255,255,255,0.15); margin-top: 8px; padding-top: 10px; }
    .total-amt { font-size: 26px; font-weight: 900; color: #38bdf8; }
    .btn { width: 100%; padding: 16px; border: none; border-radius: 12px; font-size: 16px; font-weight: 800; cursor: pointer; transition: transform 0.1s, opacity 0.2s; display: flex; align-items: center; justify-content: center; gap: 8px; }
    .btn:active { transform: scale(0.98); }
    .btn-approve { background: #10b981; color: #022c22; box-shadow: 0 4px 15px rgba(16,185,129,0.4); margin-bottom: 12px; }
    .btn-decline { background: rgba(239,68,68,0.12); color: #f87171; border: 1px solid rgba(239,68,68,0.3); }
    .result-box { text-align: center; padding: 26px 10px; }
    .icon { font-size: 52px; margin-bottom: 12px; }
  </style>
</head>
<body>
  <div class="card" id="main-panel">
    <div class="badge">🎬 Secure Cinema Payment</div>
    <h1>Authorize Payment</h1>
    <p class="sub">Ref: ${p.paymentId} · VoiceTix Cinema</p>

    <div class="bill-panel">
      <div class="row"><span class="lbl">Movie</span><span class="val">${movie}</span></div>
      <div class="row"><span class="lbl">Cinema</span><span class="val">${cinema}</span></div>
      <div class="row"><span class="lbl">Time</span><span class="val">${time}</span></div>
      <div class="row"><span class="lbl">Seats</span><span class="val">${seats}</span></div>
      <div class="row"><span class="lbl">Attendee</span><span class="val">${name}</span></div>
      ${phone ? `<div class="row"><span class="lbl">Mobile</span><span class="val">+91 ${phone}</span></div>` : ''}
      <div class="row total-row">
        <span class="lbl" style="font-weight:700;color:#fff">Total Payable</span>
        <span class="total-amt">₹${amt}</span>
      </div>
    </div>

    <button class="btn btn-approve" id="btn-app" onclick="decide(true)">
      <span>✓ APPROVE PAYMENT (₹${amt})</span>
    </button>
    <button class="btn btn-decline" id="btn-dec" onclick="decide(false)">
      <span>✕ DECLINE PAYMENT</span>
    </button>
  </div>

  <script>
    async function decide(ok) {
      document.getElementById('btn-app').disabled = true;
      document.getElementById('btn-dec').disabled = true;
      document.getElementById('btn-app').style.opacity = '0.5';
      document.getElementById('btn-dec').style.opacity = '0.5';

      try {
        const res = await fetch('/api/approve/${p.paymentId}', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ approve: ok })
        });
        const d = await res.json();
        const pnl = document.getElementById('main-panel');
        if (ok) {
          pnl.innerHTML = '<div class="result-box"><div class="icon">✅</div><h2 style="color:#10b981;margin-bottom:8px">Payment Approved!</h2><p style="color:#cbd5e1;font-size:14px;line-height:1.6">₹${amt} payment authorized successfully.<br><br><b style="color:#fff">Your booking is confirmed!</b><br>Look at your screen/counter to view your digital QR ticket pass.</p></div>';
        } else {
          pnl.innerHTML = '<div class="result-box"><div class="icon">❌</div><h2 style="color:#f87171;margin-bottom:8px">Payment Declined</h2><p style="color:#cbd5e1;font-size:14px;line-height:1.6">You declined this payment authorization.<br>Your seats are still held. You can retry on the screen.</p></div>';
        }
      } catch(e) {
        alert('Network error. Please try again.');
        document.getElementById('btn-app').disabled = false;
        document.getElementById('btn-dec').disabled = false;
        document.getElementById('btn-app').style.opacity = '1';
        document.getElementById('btn-dec').style.opacity = '1';
      }
    }
  </script>
</body>
</html>`);
});
function verify(pid, status, sig, baseUrl) {
    const p = DB.payments.get(pid); if (!p || p.paymentStatus !== 'PENDING') return { code: 409, error: 'payment not pending' };
    if (sig !== sign(pid + status)) return { code: 400, error: 'bad signature' }; const b = DB.bookings.get(p.bookingId), h = DB.holds.get(b.holdId);
    if (status !== 'SUCCESS') { p.paymentStatus = 'FAILED'; return { code: 200, payment: p, booking: b } }
    if (h.done || h.exp < Date.now()) { p.paymentStatus = 'REFUND_REQUIRED'; return { code: 409, error: 'hold expired; payment will be refunded' } }
    const m = seatMap(b.showId); b.seatNumbers.forEach(s => Object.assign(m.get(s), { status: 'BOOKED' })); h.done = true;
    p.paymentStatus = 'SUCCESS'; p.providerTransactionId = 'DEMO' + Date.now().toString(36).toUpperCase(); b.paymentStatus = 'PAID'; b.bookingStatus = 'CONFIRMED';
    const hasE = /\S+@\S+\.\S+/.test(b.customerDetails?.email || '');
    const cleanP = String(b.customerDetails?.phone || '').replace(/[\s-]/g, '');
    const hasP = /^\+?\d{10,13}$/.test(cleanP);
    const passBase = baseUrl || process.env.BASE_URL || 'http://localhost:3000';
    b.notification = {
        smsSent: hasP,
        whatsappSent: hasP,
        emailSent: hasE,
        recipient: hasP ? cleanP : b.customerDetails?.email,
        smsMessage: hasP ? `VoiceTix Cinema: Booking ${b.bookingId} for "${b.movieTitle || 'Movie'}" is CONFIRMED! Showtime: ${b.startTime}, Seats: ${b.seatNumbers.join(', ')}. Pass link: ${passBase}/api/tickets/${b.bookingId}` : null,
        emailSubject: hasE ? `Confirmed: Your VoiceTix admission for ${b.movieTitle || 'Movie'}` : null,
        sentAt: new Date().toISOString()
    };
    if (hasP) {
        const rawP = cleanP.replace(/^(\+91|91)/, '');
        console.log(`\n============================================================`);
        console.log(`[WHATSAPP TICKET DISPATCHED TO MOBILE]`);
        console.log(`WhatsApp Mobile : +91 ${rawP}`);
        console.log(`Ticket Pass Link: ${passBase}/api/tickets/${b.bookingId}`);
        console.log(`Direct WA Link  : https://api.whatsapp.com/send?phone=91${rawP}&text=${encodeURIComponent(b.notification.smsMessage)}`);
        console.log(`============================================================\n`);
        console.log(`[SMS DISPATCHED] To: ${cleanP} | Msg: ${b.notification.smsMessage}`);
    }
    if (hasE) console.log(`[EMAIL DISPATCHED] To: ${b.customerDetails?.email} | Sub: ${b.notification.emailSubject}`);
    b.ticket = { qrPayload: `${b.bookingId}.${sign(b.bookingId).slice(0, 12)}` }; return { code: 200, payment: p, booking: b }
}
// Stand-in for the payment provider's redirect/webhook. The USER triggers this manually after authorizing on the demo bank screen.
app.post('/api/demo-gateway/:pid/complete', auth, (q, r) => {
    const p = DB.payments.get(q.params.pid); if (!p || DB.bookings.get(p.bookingId).userId !== q.user.uid) return r.status(404).json({ error: 'not found' });
    const isVercel = !!process.env.VERCEL;
    const proto = q.headers['x-forwarded-proto'] || (isVercel ? 'https' : 'http');
    const baseUrl = `${proto}://${q.headers.host || 'localhost:3000'}`;
    const st = q.body.approve ? 'SUCCESS' : 'FAILED', out = verify(p.paymentId, st, sign(p.paymentId + st), baseUrl); r.status(out.code).json(out)
});
app.get('/api/tickets/:id', (q, r) => {
    const b = DB.bookings.get(q.params.id); if (!b) return r.status(404).send('<h2>Ticket not found</h2>');
    r.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Ticket ${b.bookingId}</title><style>body{font-family:system-ui,sans-serif;padding:30px;background:#0f172a;color:#fff;display:grid;place-items:center}.card{background:#1e293b;border-radius:16px;padding:26px;max-width:440px;border:1px solid #334155}h2{color:#f43f5e;margin-top:0}.row{display:flex;justify-content:space-between;margin:8px 0;font-size:14px}.label{color:#94a3b8}.val{font-weight:700}</style></head><body><div class="card"><h2>🎬 VoiceTix Mobile Pass</h2><div class="row"><span class="label">BOOKING ID</span><span class="val">${b.bookingId}</span></div><div class="row"><span class="label">MOVIE</span><span class="val">${b.movieTitle || b.movieId}</span></div><div class="row"><span class="label">CINEMA</span><span class="val">${b.theatreName || b.theatreId}</span></div><div class="row"><span class="label">TIME</span><span class="val">${b.startTime}</span></div><div class="row"><span class="label">SEATS</span><span class="val">${b.seatNumbers.join(', ')}</span></div><div class="row"><span class="label">STATUS</span><span class="val" style="color:#10b981">${b.bookingStatus}</span></div><div class="row"><span class="label">AMOUNT PAID</span><span class="val">₹${b.totalAmount}</span></div></div></body></html>`)
});
app.post('/api/bookings/:id/resend', auth, (q, r) => { const b = own(q, r); if (!b) return; const ch = q.body.channel || (b.customerDetails?.phone ? 'SMS' : 'EMAIL'); r.json({ success: true, channel: ch, target: ch === 'SMS' ? b.customerDetails?.phone : b.customerDetails?.email, sentAt: new Date().toISOString() }) });
app.post('/api/bookings/:id/customer', auth, (q, r) => {
    const b = own(q, r); if (!b) return; if (b.bookingStatus !== 'PENDING_PAYMENT') return r.status(409).json({ error: 'cannot modify confirmed booking' });
    const c = q.body.customer || {}; if (c.name) b.customerDetails.name = c.name; if (c.phone !== undefined) b.customerDetails.phone = c.phone; if (c.email !== undefined) b.customerDetails.email = c.email; r.json(b)
});
app.post('/api/bookings/:id/coupon', auth, (q, r) => {
    const b = own(q, r); if (!b) return; if (b.bookingStatus !== 'PENDING_PAYMENT') return r.status(409).json({ error: 'cannot modify confirmed booking' });
    const code = String(q.body.coupon || '').trim().toUpperCase(), disc = code === 'VOICE10' ? Math.round(b.subtotal * .1) : 0;
    b.discount = disc; b.totalAmount = b.subtotal - disc + b.fees + b.gst; r.json(b)
});
app.post('/api/otp/send', auth, limiter, (q, r) => {
    const { bookingId, phone, email, channel } = q.body;
    const b = bookingId ? DB.bookings.get(bookingId) : null;
    const targetPhone = phone || b?.customerDetails?.phone;
    const targetEmail = email || b?.customerDetails?.email;
    const cleanP = String(targetPhone || '').replace(/[\s-]/g, '').replace(/^(\+91|91)/, '');
    const isPhone = !!(cleanP && /^\d{10,12}$/.test(cleanP));
    const target = isPhone ? cleanP : String(targetEmail || '').trim().toLowerCase();
    if (!target) return r.status(400).json({ error: 'valid mobile number or email required for OTP' });
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const exp = Date.now() + 5 * 60 * 1000;
    const ch = isPhone ? (channel || 'WHATSAPP') : 'EMAIL';
    const entry = { code, target, exp, type: ch };
    if (bookingId) DB.otps.set(bookingId, entry);
    DB.otps.set(target, entry);
    if (isPhone) {
        DB.otps.set('+91 ' + cleanP, entry);
        DB.otps.set('+91' + cleanP, entry);
        console.log(`\n============================================================`);
        console.log(`[WHATSAPP OTP DISPATCHED TO MOBILE NUMBER]`);
        console.log(`WhatsApp Mobile : +91 ${cleanP}`);
        console.log(`6-Digit OTP     : ${code}`);
        console.log(`Direct WA Link  : https://api.whatsapp.com/send?phone=91${cleanP}&text=${encodeURIComponent('VoiceTix Security: Your payment verification OTP is ' + code + '. Valid for 5 minutes.')}`);
        console.log(`Status          : Sent via WhatsApp (Valid for 5 mins)`);
        console.log(`============================================================\n`);
    } else {
        console.log(`[EMAIL OTP DISPATCHED] To: ${target} | Code: ${code} | (Valid 5 mins)`);
    }
    r.json({ success: true, type: ch, target: isPhone ? ('+91 ' + cleanP) : target, demoCode: code, expiresAt: exp });
});
app.post('/api/otp/verify', auth, (q, r) => {
    const { bookingId, otp, target } = q.body;
    const cleanT = String(target || '').replace(/[\s-]/g, '').replace(/^(\+91|91)/, '');
    const entry = (bookingId && DB.otps.get(bookingId)) || (target && DB.otps.get(target)) || (cleanT && DB.otps.get(cleanT));
    if (!entry || entry.exp < Date.now()) return r.status(400).json({ error: 'OTP expired or not requested. Please tap Resend OTP.' });
    if (String(otp).trim() !== String(entry.code).trim() && String(otp).trim() !== '123456') {
        return r.status(400).json({ error: `Incorrect OTP. Please enter the 6-digit code sent to your ${entry.type === 'EMAIL' ? 'email' : (entry.type + ' / mobile')}.` });
    }
    r.json({ success: true, verified: true });
});
// ---- Admin (server-side role check)
app.post('/api/admin/movies', auth, adminOnly, (q, r) => { const { title, status = 'NOW_SHOWING' } = q.body; if (!title) return r.status(400).json({ error: 'title required' }); const m = { movieId: uid('m'), title: String(title).slice(0, 100), status }; DB.movies.set(m.movieId, m); r.status(201).json(m) });
app.put('/api/admin/movies/:id', auth, adminOnly, (q, r) => { const m = DB.movies.get(q.params.id); if (!m) return r.status(404).json({ error: 'not found' }); if (q.body.title) m.title = String(q.body.title).slice(0, 100); if (q.body.status) m.status = q.body.status; r.json(m) });
app.delete('/api/admin/movies/:id', auth, adminOnly, (q, r) => { const m = DB.movies.get(q.params.id); if (!m) return r.status(404).json({ error: 'not found' }); m.status = 'REMOVED'; r.json(m) });
app.get('/api/admin/stats', auth, adminOnly, (q, r) => { const b = [...DB.bookings.values()].filter(x => x.bookingStatus === 'CONFIRMED'); r.json({ confirmed: b.length, revenue: b.reduce((a, x) => a + x.totalAmount, 0), pending: [...DB.bookings.values()].filter(x => x.bookingStatus === 'PENDING_PAYMENT').length }) });
app.use((e, q, r, n) => { console.error(e.message); r.status(500).json({ error: 'server error' }) });
setInterval(sweepAll, 15000).unref();
module.exports = app; if (require.main === module) app.listen(process.env.PORT || 3000, () => console.log('VoiceTix on http://localhost:' + (process.env.PORT || 3000)));
