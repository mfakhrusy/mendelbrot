import { referenceOrbit,solveBoundary } from './math.js';
import { cycleModel } from './recursive-zoom.js';
let boundaryCache=null;
self.onmessage = ({data: m}) => {
  try {
    const started = performance.now();
    let x=BigInt(m.x),y=BigInt(m.y),periodic=null;
    if(m.target==='seahorse'){
      if(!boundaryCache||boundaryCache.bits!==m.bits)boundaryCache={...solveBoundary(m.bits),bits:m.bits};
      x=boundaryCache.x;y=boundaryCache.y;periodic={preperiod:20,period:5};
    }else if(m.target==='lightning'){x=0n;y=1n<<BigInt(m.bits);periodic={preperiod:2,period:2};}
    // Guided rendering only needs the preperiod plus one cycle, regardless of
    // how many recursive zoom levels have already been traversed.
    const result = referenceOrbit(x,y,m.bits,periodic?periodic.preperiod+periodic.period:m.iterations,periodic);
    const model=periodic?cycleModel(result.data,periodic.preperiod,periodic.period):null;
    self.postMessage({...result,model,periodic, x:x.toString(),y:y.toString(),id:m.id, ms:performance.now()-started}, [result.data.buffer,result.prefix.buffer]);
  } catch (e) { self.postMessage({id:m.id, error:e.message}); }
};
