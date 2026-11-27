export const vertex = `#version 300 es
in vec2 aPosition;
void main() { gl_Position=vec4(aPosition,0,1); }
`;
export const fragment = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uOrbit;
uniform vec2 uResolution;
uniform float uAspect, uExponent, uFraction;
uniform vec2 uOffset;
uniform int uIterations, uLength, uProbe, uPalette;
uniform int uStart;
uniform int uSkipped, uPreperiod, uPeriod;
uniform vec4 uDerivative;
uniform float uDerivativeExponent;
uniform vec2 uColorPhase;
out vec4 fragColor;
// Double-single arithmetic preserves approximately 48 significant bits.
vec2 add(vec2 a,vec2 b) {
  float s=a.x+b.x, v=s-a.x;
  float t=((b.x-v)+(a.x-(s-v)))+a.y+b.y;
  float h=s+t; return vec2(h,t-(h-s));
}
vec2 product(vec2 a,vec2 b) {
  float ca=4097.*a.x, cb=4097.*b.x;
  float ah=ca-(ca-a.x), bh=cb-(cb-b.x);
  float al=a.x-ah, bl=b.x-bh;
  float p=a.x*b.x;
  float err=((ah*bh-p)+ah*bl+al*bh)+al*bl;
  err+=a.x*b.y+a.y*b.x;
  float h=p+err; return vec2(h,err-(h-p));
}
vec4 cmul(vec4 a,vec4 b) {return vec4(add(product(a.xy,b.xy),-product(a.zw,b.zw)),add(product(a.xy,b.zw),product(a.zw,b.xy)));}
vec4 cadd(vec4 a,vec4 b) {return vec4(add(a.xy,b.xy),add(a.zw,b.zw));}
vec4 ref(int i) {
  if(uPeriod>0 && i>=uPreperiod)i=uPreperiod+(i-uPreperiod)%uPeriod;
  return texelFetch(uOrbit,ivec2(i%1024,i/1024),0);
}
vec2 val(vec4 a) {return vec2(a.x+a.y,a.z+a.w);}
vec3 palette(float t) {
  if(uPalette==1) return .50+.49*cos(6.2831853*(vec3(.0,.13,.27)+t*vec3(.8,1.,1.1)));
  if(uPalette==2) return .5+.49*cos(6.2831853*(vec3(.12,.38,.58)+t));
  return .5+.49*cos(6.2831853*(vec3(.57,.32,.18)+t));
}
void main() {
  vec2 pixel=(gl_FragCoord.xy/uResolution-.5)*vec2(uAspect,1.);
  vec2 dc0=(pixel*uFraction)+uOffset;
  vec4 dc=vec4(dc0.x,0.,dc0.y,0.);
  vec4 d=cmul(uDerivative,dc); float e=uExponent+uDerivativeExponent;
  int j=uStart, count=uIterations; float magnitude=0.;
  for(int i=0;i<uIterations;i++) {
    // A floating exponent keeps the pixel delta alive below 2^-1024.
    vec4 zref=ref(j);
    float ne=max(max(e,2.*e),uExponent);
    vec4 nd=cadd(cadd(2.*cmul(zref,d)*exp2(e-ne),cmul(d,d)*exp2(2.*e-ne)),dc*exp2(uExponent-ne));
    float m=max(abs(nd.x),abs(nd.z));
    if(m>.000244140625 && m<4096.) {d=nd;e=ne;}
    else if(m>0.) { float q=floor(log2(m)); d=nd*exp2(-q); e=ne+q; }
    else { d=vec4(0.); e=uExponent; }
    j++;
    if(e>24.) { count=i+1; magnitude=65536.; break; }
    vec4 delta=e < -120. ? vec4(0.) : d*exp2(e);
    vec4 z=cadd(ref(j),delta);
    magnitude=dot(val(z),val(z));
    if(magnitude>256.) {count=i+1; break;}
    // Rebase to Z_0 when cancellation threatens perturbation accuracy.
    if((uPeriod==0 && j>=uLength-1) || (e > -120. && magnitude < .25*dot(val(delta),val(delta)))) {
      float zm=max(abs(z.x),abs(z.z));
      if(zm>0.) { e=floor(log2(zm)); d=z*exp2(-e); }
      else {d=vec4(0.); e=uExponent;}
      j=0;
    }
  }
  bool inside=count==uIterations;
  if(uProbe==1) {
    int total=min(65535,count+uSkipped);
    fragColor=vec4(float(total%256)/255.,float(total/256)/255.,inside?0.:1.,1.); return;
  }
  if(inside) {fragColor=vec4(.012,.018,.030,1.);return;}
  float smoothCount=float(count)+1.-log2(max(1.,log2(max(magnitude,1.))*.5));
  float t=smoothCount*.018+uColorPhase.x;
  vec3 color=palette(t);
  color*=.72+.28*cos(smoothCount*.11+uColorPhase.y);
  fragColor=vec4(pow(max(color,0.),vec3(.9)),1.);
}
`;
