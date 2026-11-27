// A repelling periodic orbit lets us recursively fold arbitrarily many turns
// into one bounded local coordinate frame, without replaying an image.
const multiply=(a,b)=>[a[0]*b[0]-a[1]*b[1],a[0]*b[1]+a[1]*b[0]];
const add=(a,b)=>[a[0]+b[0],a[1]+b[1]];
function divide(a,b){const d=b[0]*b[0]+b[1]*b[1];return [(a[0]*b[0]+a[1]*b[1])/d,(a[1]*b[0]-a[0]*b[1])/d];}
function scaled(z,exponent=0){const m=Math.max(Math.abs(z[0]),Math.abs(z[1]));if(!m)return {z:[0,0],exponent:0};const q=Math.floor(Math.log2(m));return {z:[z[0]*2**-q,z[1]*2**-q],exponent:exponent+q};}
function times(a,b){return scaled(multiply(a.z,b.z),a.exponent+b.exponent);}
// Exponentiation by squaring is recursive, O(log n), and never materializes
// the enormous power in an ordinary floating-point number.
export function recursivePower(base,n){
  if(n===0)return {z:[1,0],exponent:0};
  if(n===1)return base;
  const half=recursivePower(base,Math.floor(n/2)),square=times(half,half);
  return n%2?times(square,base):square;
}
export function cycleModel(data,preperiod=20,period=5){
  const at=i=>[data[4*i]+data[4*i+1],data[4*i+2]+data[4*i+3]];
  let derivative=[0,0];
  for(let i=0;i<preperiod;i++)derivative=add(multiply(at(i).map(v=>2*v),derivative),[1,0]);
  let multiplier=[1,0],parameter=[0,0];
  for(let i=preperiod;i<preperiod+period;i++){
    const a=at(i).map(v=>2*v);
    multiplier=multiply(a,multiplier);parameter=add(multiply(a,parameter),[1,0]);
  }
  const correction=divide(parameter,[multiplier[0]-1,multiplier[1]]);
  const coefficient=add(derivative,correction);
  return {preperiod,period,multiplier,correction,coefficient,logScale:Math.log2(Math.hypot(...multiplier)),coefficientLog:Math.log2(Math.hypot(...coefficient))};
}
export function recursiveFrame(model,zoomExponent,radius){
  // Keep the first retained delta below 2^-72. This leaves a generous
  // nonlinear-error margin even across the critical orbit's early turns.
  const turns=Math.max(0,Math.floor((-zoomExponent-Math.log2(radius)-model.coefficientLog-72)/model.logScale));
  if(!turns)return {start:0,skipped:0,derivative:{z:[0,0],exponent:0},turns:0};
  const power=recursivePower(scaled(model.multiplier),turns);
  let derivative=times(power,scaled(model.coefficient));
  const factor=2**-derivative.exponent;
  derivative=scaled([derivative.z[0]-model.correction[0]*factor,derivative.z[1]-model.correction[1]*factor],derivative.exponent);
  return {start:model.preperiod,skipped:model.preperiod+turns*model.period,derivative,turns};
}
