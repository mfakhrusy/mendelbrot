// Coordinates are fixed-point BigInts. There is no fixed precision ceiling.
export function fromDecimal(s, bits) {
  const negative = s.startsWith('-');
  const [whole, fraction = ''] = s.replace(/^[+-]/, '').split('.');
  const n = (BigInt(whole + fraction) << BigInt(bits)) / (10n ** BigInt(fraction.length));
  return negative ? -n : n;
}
export function toNumber(n, bits) {
  const shift = Math.max(0, bits - 54);
  return Number(n >> BigInt(shift)) * 2 ** (shift - bits);
}
export function offsetInteger(value, exponent, bits) {
  const shift = bits + Math.floor(exponent) - 48;
  const mantissa = BigInt(Math.round(value * 2 ** (exponent - Math.floor(exponent) + 48)));
  return shift >= 0 ? mantissa << BigInt(shift) : mantissa >> BigInt(-shift);
}
export function solveBoundary(bits) {
  // The selected Misiurewicz parameter satisfies z_25(c) = z_20(c),
  // with a repelling period-five cycle. Newton refinement adds precision
  // without replacing the mathematical destination as the camera descends.
  const workBits=bits+64,p=BigInt(workBits),one=1n<<p;
  let cx=fromDecimal('-0.7482409297559107',workBits),cy=fromDecimal('0.13646638958862622',workBits);
  for(let step=0;step<32;step++){
    let x=0n,y=0n,dx=0n,dy=0n,ax=0n,ay=0n,adx=0n,ady=0n;
    for(let i=1;i<=25;i++){
      const ndx=((2n*(x*dx-y*dy))>>p)+one,ndy=(2n*(x*dy+y*dx))>>p;
      const nx=((x*x-y*y)>>p)+cx,ny=(2n*x*y>>p)+cy;
      x=nx;y=ny;dx=ndx;dy=ndy;
      if(i===20){ax=x;ay=y;adx=dx;ady=dy;}
    }
    const fr=x-ax,fi=y-ay,dr=dx-adx,di=dy-ady,den=dr*dr+di*di;
    if(den===0n)throw Error('Boundary root refinement lost its derivative.');
    const sx=((fr*dr+fi*di)<<p)/den,sy=((fi*dr-fr*di)<<p)/den;
    cx-=sx;cy-=sy;
    if(sx>=-4n&&sx<=4n&&sy>=-4n&&sy<=4n)return {x:cx>>64n,y:cy>>64n};
  }
  // Fixed-point rounding can settle into a cycle of a few least-significant
  // guard bits. Those 64 guard bits are discarded on return.
  return {x:cx>>64n,y:cy>>64n};
}
export function referenceOrbit(cx, cy, bits, iterations, periodic=null) {
  const p = BigInt(bits), data = new Float32Array((iterations + 1) * 4);
  const prefix = new Float64Array((iterations+1)*4);
  let dr=0,di=0,de=0,errorLog=-Infinity,safeLog=Infinity,oldReal=0,oldImag=0;
  const logAdd=(a,b)=>{const m=Math.max(a,b);return Number.isFinite(m)?m+Math.log2(2**(a-m)+2**(b-m)):m;};
  let x = 0n, y = 0n, length = 1;
  const cycle=[];
  const escape = 256n << p;
  for (let i = 1; i <= iterations; i++) {
    let real,imag;
    if(periodic&&i>=periodic.preperiod+periodic.period){
      [real,imag]=cycle[(i-periodic.preperiod)%periodic.period];
    }else{
      const xx = x * x >> p, yy = y * y >> p;
      y = ((2n * x * y) >> p) + cy;
      x = xx - yy + cx;
      real=toNumber(x,bits);imag=toNumber(y,bits);
      if(periodic&&i>=periodic.preperiod)cycle.push([real,imag]);
    }
    const rh=Math.fround(real), ih=Math.fround(imag);
    data[4*i]=rh;data[4*i+1]=real-rh;
    data[4*i+2]=ih;data[4*i+3]=imag-ih;
    // First-order series acceleration. Track a conservative quadratic error
    // bound, so only a prefix with negligible nonlinear error may be skipped.
    const dLog=de+Math.log2(Math.hypot(dr,di));
    errorLog=logAdd(Math.log2(2*Math.hypot(oldReal,oldImag))+errorLog,2*dLog);
    let nr=2*(oldReal*dr-oldImag*di),ni=2*(oldReal*di+oldImag*dr);
    if(de<0){nr=nr*2**de+1;ni*=2**de;de=0;}
    else nr+=2**(-de);
    const norm=Math.max(Math.abs(nr),Math.abs(ni));
    if(norm>0){const q=Math.floor(Math.log2(norm));dr=nr*2**-q;di=ni*2**-q;de+=q;}else{dr=0;di=0;de=0;}
    const nextLog=de+Math.log2(Math.hypot(dr,di));
    // 2^-38 relative truncation error, with every intermediate delta < 2^-20.
    safeLog=Math.min(safeLog,-38+nextLog-errorLog,-20-nextLog);
    prefix[4*i]=dr;prefix[4*i+1]=di;prefix[4*i+2]=de;prefix[4*i+3]=safeLog;
    oldReal=real;oldImag=imag;
    length = i + 1;
    if (!periodic&&(x * x + y * y >> p) > escape) break;
  }
  return { data, length, prefix };
}
export function escapeBig(cx, cy, bits, iterations) {
  const p = BigInt(bits); let x = 0n, y = 0n;
  for (let i = 0; i < iterations; i++) {
    const xx = x*x >> p, yy = y*y >> p;
    y = (2n*x*y >> p) + cy; x = xx-yy+cx;
    if ((x*x+y*y >> p) > (256n << p)) return i + 1;
  }
  return iterations;
}
