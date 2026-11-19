const test=require('node:test'),assert=require('assert'),{parse}=require('../nlp/nlp'),D=require('../nlp/dataset.json');
for(const d of D)test('NLP: '+d.text,()=>{const p=parse(d.text);assert.strictEqual(p.i,d.intent);for(const[k,v]of Object.entries(d.entities))assert.deepStrictEqual(p.e[k],v)});
