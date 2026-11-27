import assert from 'node:assert/strict';
import {fromDecimal,toNumber,offsetInteger,referenceOrbit,escapeBig,solveBoundary} from '../dist/math.js';
import {cycleModel,recursiveFrame,recursivePower} from '../dist/recursive-zoom.js';
const bits=192;
assert.equal(fromDecimal('-2',bits),-2n<<192n);
assert.equal(toNumber(fromDecimal('0.125',bits),bits),.125);
assert.equal(escapeBig(0n,0n,bits,1000),1000);
assert.equal(escapeBig(fromDecimal('-1',bits),0n,bits,1000),1000);
assert.equal(escapeBig(fromDecimal('1',bits),0n,bits,1000),4);
assert.equal(escapeBig(fromDecimal('-2',bits),0n,bits,1000),1000);
// At 2^1100 magnification a normal Number offset underflows to zero.
const deepBits=1280, tiny=offsetInteger(-.25,2-1100,deepBits);
assert.notEqual(tiny,0n);
assert.equal(2**-1100,0);
const escaped=escapeBig(fromDecimal('-2',deepBits)+tiny,0n,deepBits,800);
assert.ok(escaped>540&&escaped<570,`deep escape: ${escaped}`);
const ref=referenceOrbit(fromDecimal('-2',deepBits),0n,deepBits,800);
assert.equal(ref.length,801);
assert.equal(ref.data[4],-2);
assert.equal(ref.data[8],2);
assert.equal(ref.data[3200],2);
const root=solveBoundary(256),refined=solveBoundary(1280);
assert.equal(refined.x>>1024n,root.x);
assert.equal(refined.y>>1024n,root.y);
let x=0n,y=0n,z20;
for(let i=1;i<=25;i++){
  const nx=((x*x-y*y)>>256n)+root.x;y=(2n*x*y>>256n)+root.y;x=nx;
  if(i===20)z20=[x,y];
}
const residual=(x-z20[0])**2n+(y-z20[1])**2n;
assert.ok(residual < 1n<<64n,'algebraic boundary residual is below 2^-224');
const periodic=referenceOrbit(root.x,root.y,256,1000,{preperiod:20,period:5});
assert.deepEqual(Array.from(periodic.data.slice(80,84)),Array.from(periodic.data.slice(100,104)));
let mr=1,mi=0;
for(let i=20;i<25;i++){
  const zr=periodic.data[i*4]+periodic.data[i*4+1],zi=periodic.data[i*4+2]+periodic.data[i*4+3];
  const nr=2*(mr*zr-mi*zi);mi=2*(mr*zi+mi*zr);mr=nr;
}
assert.ok(Math.hypot(mr,mi)>10,'the eventual cycle is repelling');
assert.ok(periodic.prefix[4*500+3]<periodic.prefix[4*100+3]);
console.log('Passed: known membership, decimal conversion, reference orbit, 2^1100 offsets, 1280-bit root consistency, algebraic root residual, and periodic reference reuse.');
const model=cycleModel(periodic.data);
for(const turns of [1,2,3,16,64]){
  const actual=recursivePower({z:[.5,.5],exponent:0},turns);
  let z=[1,0];for(let i=0;i<turns;i++)z=[z[0]*.5-z[1]*.5,z[0]*.5+z[1]*.5];
  assert.ok(Math.abs(actual.z[0]*2**actual.exponent-z[0])<1e-14);
  assert.ok(Math.abs(actual.z[1]*2**actual.exponent-z[1])<1e-14);
}
const frame=recursiveFrame(model,-1098,1);
assert.ok(frame.turns>100);
assert.ok(frame.derivative.exponent-1098 < -60,'local recursive delta remains small');
assert.ok(frame.skipped>1000);
assert.equal(frame.start,20);
const huge=recursiveFrame(model,-1e9,1);
assert.ok(Number.isFinite(huge.derivative.z[0])&&Number.isFinite(huge.derivative.exponent));
console.log('Passed: recursive composition, bounded local frames, and billion-bit exponent setup without overflow.');
