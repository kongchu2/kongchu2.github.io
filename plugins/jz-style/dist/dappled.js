const pt=`
  attribute vec2 position;
  varying vec2 vUv;
  void main() {
    vUv = position * 0.5 + 0.5;
    gl_Position = vec4(position, 0.0, 1.0);
  }
`,gt=`#extension GL_OES_standard_derivatives : enable
  precision highp float;
  #define MAXSEG 1024         // loop ceiling; actual count is uSegCount
  uniform sampler2D uSegTex; // L-system segments packed as RGBA8 (16-bit), 3 texels/seg
  uniform float uPosScale;   // decode: pos = raw * uPosScale - 1.0
  uniform float uWidScale;   // decode: width = raw * uWidScale
  uniform int uSegCount;     // number of live segments
  uniform vec2 uLeafGrad;    // canopy gradient dir in uv space (toward the origin sides)
  uniform float uLeafFall;   // ramp strength of leaf cover along the gradient
  uniform float uLeafFollow; // 0 = uniform leaf depth, 1 = leaf depth tracks branches
  uniform float uTrunkCount; // 0, 1, or 2 decorative trunks
  uniform vec2 uTrunkX;      // their x positions (uv space)
  uniform float uTrunkW;     // trunk half-width (uv space), seeded thin
  uniform float uTime;       // real seconds (slow canopy drift)
  uniform vec2 uDisp[4];     // per-layer cumulative sway displacement
  uniform vec2 uResolution;
  uniform vec3 uColorA;      // lit wall
  uniform vec3 uColorMid;    // glow (transition zones)
  uniform vec3 uColorB;      // shadow
  uniform float uContrast;
  uniform float uCenter;
  uniform float uGoldLo;
  uniform float uGoldHi;
  uniform float uCanopy;
  uniform vec4 uLayerOn;     // per-layer enable
  uniform vec4 uBlur;        // per-layer blur (distance): 0 sharp+dark -> 1 soft+faint
  uniform float uDither;     // 1 dithered, 0 hard
  uniform vec2 uSeed;        // random per-load offset into the noise field
  uniform float uParallax;   // -1..1 (mouse x / device tilt); shifts layers by depth
  uniform vec3 uFloor;       // per-layer floor top range (trunk, thick, thin); floor = blur^2 * top
  varying vec2 vUv;

  float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
  float noise(vec2 p){
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
               mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
  }
  float fbm(vec2 p){
    float v = 0.0, a = 0.55;
    for (int i = 0; i < 4; i++) { v += a * noise(p); p = p * 2.02 + 7.0; a *= 0.5; }
    return v;
  }
  // ridged noise -> thin filament ridges (branch-like)
  float ridged(vec2 p){ return 1.0 - abs(2.0 * noise(p) - 1.0); }
  float ridgedFbm(vec2 p){
    float v = 0.0, a = 0.6;
    for (int i = 0; i < 4; i++) { v += a * ridged(p); a *= 0.5; p = p * 1.97 + 3.3; }
    return v;
  }
  // unpack a 16-bit value stored across two RGBA8 channels ([0,1] each)
  float dec16(vec2 c){ return (c.x * 255.0 * 256.0 + c.y * 255.0) / 65535.0; }
  // shadow from the L-system branch segments (grown CPU-side, packed into a texture;
  // segments are tapered capsules in buv space, x: 0..aspect, y: 0..1). we also grab
  // the local limb radius at the nearest point so thin limbs dither.
  // returns (signed distance to nearest limb surface, blended local depth). shared
  // by the branch shadow and the leaf layer so we only walk the segments once.
  vec2 branchField(vec2 buv){
    buv.x += uParallax * 0.04;
    buv += uDisp[1] * 0.5; // wind sway
    float d1 = 1e9, d2 = 1e9;     // nearest + runner-up limb distance
    float dep1 = 0.0, dep2 = 0.0; // ...and their depths
    float rowScale = 1.0 / float(MAXSEG);
    for (int i = 0; i < MAXSEG; i++){
      if (i >= uSegCount) break;
      float row = (float(i) + 0.5) * rowScale;
      vec4 t0 = texture2D(uSegTex, vec2(0.5 / 4.0, row)); // x0,y0
      vec4 t1 = texture2D(uSegTex, vec2(1.5 / 4.0, row)); // x1,y1
      vec4 t2 = texture2D(uSegTex, vec2(2.5 / 4.0, row)); // w0,w1
      vec2 a = vec2(dec16(t0.rg), dec16(t0.ba)) * uPosScale - 1.0;
      vec2 bb = vec2(dec16(t1.rg), dec16(t1.ba)) * uPosScale - 1.0;
      vec2 pa = buv - a, ba = bb - a;
      float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
      float r = mix(dec16(t2.rg), dec16(t2.ba), h) * uWidScale;
      float dist = length(pa - ba * h) - r;
      if (dist < d2) {
        float dep = dec16(texture2D(uSegTex, vec2(3.5 / 4.0, row)).rg);
        if (dist < d1) { d2 = d1; dep2 = dep1; d1 = dist; dep1 = dep; }
        else { d2 = dist; dep2 = dep; }
      }
    }
    // depth from the nearest limb alone is piecewise-constant: it partitions
    // the frame into voronoi plates around each segment, and every plate
    // boundary prints as a seam (a jump in penumbra width, umbra darkness, and
    // the leaf softness/floor that follow depth). blend the two nearest depths
    // across the equidistance locus so the depth field is continuous.
    float t = clamp(0.5 + 0.5 * (d2 - d1) / 0.12, 0.0, 1.0);
    return vec2(d1, mix(dep2, dep1, t));
  }
  // penumbra: the shadow darkens across a band whose half-width grows with the
  // caster's distance (depth). a thick limb is wider than the band, so its core
  // reaches full umbra while the edges lighten; a thin twig is narrower than the
  // band, so its penumbras overlap and it never fully darkens (dithers on its own).
  float branchShadow(float d, float nearDepth){
    float pen = 0.006 + nearDepth * 0.06;
    float shadow = 1.0 - smoothstep(-pen, pen, d); // 1 deep inside -> 0 outside
    float umbra = mix(0.03, 0.34, nearDepth); // far limbs' deepest shadow is fainter
    return mix(1.0, umbra, shadow);
  }
  // foliage: blobby noise. blur -> softer penumbra + fainter shadow. cover (0..1)
  // biases density: high near the scene's canopy origin, sparse in the open area.
  float leafLayer(vec2 buv, float scale, vec2 disp, float b, vec2 seed, float cover){
    buv.x += uParallax * (0.15 + b) * 0.1; // depth-based parallax (far layers shift more)
    vec2 p = buv * scale + disp + seed;
    float soft = 0.05 + b * 0.30;
    float floorT = b * 0.38;
    float thr = mix(0.85, 0.48, cover); // low cover -> high threshold -> few leaves
    float s = smoothstep(thr + soft, thr - soft, fbm(p));
    return mix(1.0, floorT, s);
  }
  // branches: domain-warped, anisotropic ridged noise read as wandering limbs.
  // higher thick -> thinner branches; blur -> softer + fainter shadow.
  float branchLayer(vec2 buv, float scale, vec2 disp, float thick, float b, vec2 seed, float topRange){
    buv.x += uParallax * (0.15 + b) * 0.1; // depth-based parallax
    vec2 p = buv * scale + disp + seed;
    p += (vec2(noise(p * 0.5 + 2.1), noise(p * 0.5 + 8.7)) - 0.5) * 0.8; // gentle wander, not swirly ribbons
    mat2 R = mat2(0.86, -0.51, 0.51, 0.86);
    float r = ridgedFbm(R * p * vec2(1.0, 0.35)); // anisotropy = longer, connected limbs
    float soft = 0.03 + b * 0.22;
    float s = smoothstep(thick, thick + soft, r); // 1 on the ridge (wood)
    float floorT = b * b * topRange; // shadow fades with distance^2 toward topRange
    return mix(1.0, floorT, s);
  }
  // decorative thick trunk(s): 0-2 near-vertical solid bands. count and x-positions
  // are decided CPU-side (uTrunkCount, uTrunkX) so they're rare and sit near the
  // scene's focus column. fixed-width, so they can't blow up into a slab. uv-space.
  float trunkLayer(vec2 uv, float thick, float b, float topRange){
    if (uTrunkCount < 0.5) return 1.0; // no trunk this scene
    float lean = (noise(vec2(uTrunkX.x * 41.0, uv.y * 0.6)) - 0.5) * 0.06; // gentle wobble
    float x = uv.x + lean + uParallax * 0.015;
    float halfw = uTrunkW; // seeded width (CPU-side, biased thin)
    float d = abs(x - uTrunkX.x);
    if (uTrunkCount > 1.5) d = min(d, abs(x - uTrunkX.y));
    float s = 1.0 - smoothstep(halfw, halfw + 0.02 + b * 0.1, d);
    float floorT = b * b * topRange;
    return mix(1.0, floorT, s);
  }
  float bayer4(vec2 c){
    int x = int(mod(c.x, 4.0));
    int y = int(mod(c.y, 4.0));
    int i = x + y * 4;
    float t = 5.0;
    if (i==0) t=0.0; else if (i==1) t=8.0; else if (i==2) t=2.0; else if (i==3) t=10.0;
    else if (i==4) t=12.0; else if (i==5) t=4.0; else if (i==6) t=14.0; else if (i==7) t=6.0;
    else if (i==8) t=3.0; else if (i==9) t=11.0; else if (i==10) t=1.0; else if (i==11) t=9.0;
    else if (i==12) t=15.0; else if (i==13) t=7.0; else if (i==14) t=13.0;
    return (t + 0.5) / 16.0;
  }

  void main(){
    vec2 uv = vUv;
    float aspect = uResolution.x / max(uResolution.y, 1.0);
    vec2 buv = vec2(uv.x * aspect, uv.y);
    float t = uTime;

    // walk the L-system segments once; reuse the field for branches AND leaves
    vec2 bf = branchField(buv); // (signed dist, depth) of the nearest limb
    // rare decorative thick trunk(s), count/positions decided CPU-side
    float l0 = mix(1.0, trunkLayer(uv, 0.45, uBlur.x, uFloor.x), uLayerOn.x);
    float l1 = mix(1.0, branchShadow(bf.x, bf.y), uLayerOn.y);
    float l2 = 1.0;
    // leaf cover ramps along the scene gradient: dense on the branch-origin side(s),
    // sparse on the open side (uv-0.5 projected onto the gradient direction)
    float leafCover = clamp(0.55 + dot(uLeafGrad, uv - 0.5) * uLeafFall, 0.12, 1.0);
    // leaf depth follows the nearby branch (sitting just beyond the twigs) so foliage
    // softens/fades with the limbs it hangs from instead of being one flat plane
    float leafDepth = mix(uBlur.w, clamp(bf.y + 0.2, 0.0, 1.0), uLeafFollow);
    float l3 = mix(1.0, leafLayer(buv, 11.0, uDisp[3], leafDepth, uSeed + vec2(13.0, 89.0), leafCover), uLayerOn.w);

    // canopy glow: higher frequency so several blotches always fit the frame
    // (the frame mean can't wander far from 0.5 -> no whole-frame dim-out into
    // mush or shadow), and a wide smoothstep band that fbm rarely exits, so the
    // field never sits on a 0/1 plateau whose clamped contour is a straight line
    float canopy = smoothstep(0.15, 0.85, fbm(buv * 0.7 + vec2(t * 0.01, 19.0) + uSeed + vec2(101.0, 57.0)));
    // multiplicative so opaque wood stays opaque (additive bias was lifting the
    // trunk into the dithered mid-tones); only modulates light that gets through
    float modulate = 1.0 + (canopy - 0.5) * uCanopy + (1.0 - uv.y) * 0.10 - uv.x * 0.05;

    float light = pow(l0 * l1 * l2 * l3, 0.6) * 1.3 * modulate;
    light = clamp((light - 0.5) * uContrast + uCenter, 0.0, 1.0);

    // 2-tone ordered dither; gold only where tone is mid AND it's an actual
    // light/dark edge (the penumbra rim), not flat interiors.
    float bayer = uDither > 0.5 ? bayer4(gl_FragCoord.xy) : 0.5;
    float bayerG = uDither > 0.5 ? bayer4(gl_FragCoord.xy + vec2(2.0, 1.0)) : 0.5;
    float lit = step(bayer, light);
    float goldMix = smoothstep(uGoldLo, uGoldHi, light) * smoothstep(0.015, 0.1, fwidth(light));
    float darkIsGold = step(bayerG, goldMix);
    vec3 dark = darkIsGold > 0.5 ? uColorMid : uColorB;
    vec3 col = lit > 0.5 ? uColorA : dark;
    gl_FragColor = vec4(col, 1.0);
  }
`;function bt(m){let i=m.trim().replace("#","");i.length===3&&(i=i[0]+i[0]+i[1]+i[1]+i[2]+i[2]);const e=parseInt(i.slice(0,6),16);return[(e>>16&255)/255,(e>>8&255)/255,(e&255)/255]}function P(m){const i=getComputedStyle(document.documentElement).getPropertyValue(m);return i&&i.trim().startsWith("#")?bt(i):[0,0,0]}function ot(m,i){const e=parseFloat(getComputedStyle(document.documentElement).getPropertyValue(m));return isNaN(e)?i:e}function at(m){return P(m).map(i=>Math.round(i*255)).join(",")}function vt(m){const i=getComputedStyle(m),e=parseFloat(i.paddingLeft)+parseFloat(i.paddingRight),H=parseFloat(i.paddingTop)+parseFloat(i.paddingBottom);return[Math.max(1,m.clientWidth-e),Math.max(1,m.clientHeight-H)]}function xt(m){const i=document.createElement("canvas");i.className="dappled-canvas",m.appendChild(i);const e=i.getContext("webgl",{antialias:!1,alpha:!1});if(!e){console.error("[dappled-light] no WebGL");return}e.getExtension("OES_standard_derivatives");const H=(t,a)=>{const n=e.createShader(t);return e.shaderSource(n,a),e.compileShader(n),e.getShaderParameter(n,e.COMPILE_STATUS)||console.error("[dappled-light] shader:",e.getShaderInfoLog(n)),n},C=e.createProgram();e.attachShader(C,H(e.VERTEX_SHADER,pt)),e.attachShader(C,H(e.FRAGMENT_SHADER,gt)),e.linkProgram(C),e.getProgramParameter(C,e.LINK_STATUS)||console.error("[dappled-light] link:",e.getProgramInfoLog(C)),e.useProgram(C);const rt=e.createBuffer();e.bindBuffer(e.ARRAY_BUFFER,rt),e.bufferData(e.ARRAY_BUFFER,new Float32Array([-1,-1,3,-1,-1,3]),e.STATIC_DRAW);const Ae=e.getAttribLocation(C,"position");e.enableVertexAttribArray(Ae),e.vertexAttribPointer(Ae,2,e.FLOAT,!1,0,0);const l=t=>e.getUniformLocation(C,t),u={uTime:l("uTime"),uDisp:l("uDisp[0]"),uResolution:l("uResolution"),uColorA:l("uColorA"),uColorMid:l("uColorMid"),uColorB:l("uColorB"),uContrast:l("uContrast"),uCenter:l("uCenter"),uGoldLo:l("uGoldLo"),uGoldHi:l("uGoldHi"),uCanopy:l("uCanopy"),uLayerOn:l("uLayerOn"),uBlur:l("uBlur"),uDither:l("uDither"),uSeed:l("uSeed"),uParallax:l("uParallax"),uFloor:l("uFloor"),uSegTex:l("uSegTex"),uPosScale:l("uPosScale"),uWidScale:l("uWidScale"),uSegCount:l("uSegCount"),uLeafGrad:l("uLeafGrad"),uLeafFall:l("uLeafFall"),uLeafFollow:l("uLeafFollow"),uTrunkCount:l("uTrunkCount"),uTrunkX:l("uTrunkX"),uTrunkW:l("uTrunkW")};e.uniform2f(u.uSeed,Math.random()*100,Math.random()*100);const r={contrast:1.6,center:ot("--komorebi-center",.38),goldLo:.45,goldHi:.7,canopy:1,dither:1,layerOn:[1,1,0,1],blur:[0,.12,.35,.45],floor:[.1,.4,.7],sensitivity:5,rest:.35,gustSpeed:1},U=1024,ue=4,de=.1,q=new Uint8Array(ue*U*4);let ce=0,D=12,Re=0,Pe=1,De=0,Fe=.5,Ge=.5,_e=.018;const $=e.createTexture();e.bindTexture(e.TEXTURE_2D,$),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MIN_FILTER,e.NEAREST),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MAG_FILTER,e.NEAREST),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_WRAP_S,e.CLAMP_TO_EDGE),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_WRAP_T,e.CLAMP_TO_EDGE);let Xe=Math.floor(Math.random()*1e9);const o={sceneType:-1,trunkCount:-1,leafBias:1.4,leafFollow:.6,rootOffset:.9,nTrees:6,trunkWidth:.035,lenRatio:16,maxLen:.4,curl:.3,split3:.3,forkProb:.7,depthDrift:.4,leader:.618,golden:1,conserve:.95,endPx:.5},it=t=>()=>{t|=0,t=t+1831565813|0;let a=Math.imul(t^t>>>15,1|t);return a=a+Math.imul(a^a>>>7,61|a)^a,((a^a>>>14)>>>0)/4294967296},Ue=()=>{const t=O/Math.max(F,1),a=F,n=it(Xe),d=[],w=o.endPx/(2*a),p=(c,f,h)=>Math.max(f,Math.min(h,c)),x=Math.PI*(3-Math.sqrt(5)),E=2/(1+Math.sqrt(5)),b=(c,f)=>Math.min(.98,Math.max(.02,c+(n()-.5)*f)),T=(c,f,h,k,R,S,X)=>{if(k<w||d.length>=U)return;const oe=Math.min(k*o.lenRatio,o.maxLen)*(.85+n()*.3),I=h+R+(n()-.5)*.05,ae=c+Math.cos(I)*oe,re=f+Math.sin(I)*oe,ie=k*.97;d.push([c,f,ae,re,k,ie,X]);const se=ie*ie*o.conserve;if(n()>=o.forkProb){T(ae,re,I,Math.sqrt(se),R,S+x,b(X,o.depthDrift*.25));return}const et=n()<o.split3?3:2,ct=se*(o.leader*(.92+n()*.16)),Se=Math.sqrt(Math.min(se,ct));T(ae,re,I,Se,R,S+x,b(X,o.depthDrift*.25));let Le=Math.max(0,se-Se*Se);for(let le=0;le<et-1;le++){const tt=le===et-2?Le:Le*(.45+n()*.25);Le-=tt;const Me=Math.sqrt(tt);if(Me<w)continue;const nt=S+(le+1)*x,ft=o.golden*Math.cos(nt)+(1-o.golden)*(n()-.5)*2>=0?1:-1,ht=1-Math.min(1,Me/Math.max(ie,1e-6)),mt=I+ft*(.35+ht*.55)+(n()-.5)*.15;T(ae,re,mt,Me,(n()-.5)*o.curl,nt,b(X,o.depthDrift))}},ke=[{edges:[2],fx:.33,top:!0,gx:0,gy:1},{edges:[2,0],fx:.33,top:!0,gx:-.7,gy:.7},{edges:[2,1],fx:.67,top:!0,gx:.7,gy:.7},{edges:[3,1],fx:.67,top:!1,gx:.7,gy:-.7},{edges:[3,0],fx:.33,top:!1,gx:-.7,gy:-.7}],te=o.sceneType>=0?Math.min(4,Math.round(o.sceneType)):Math.floor(n()*ke.length),v=ke[te];Re=v.gx,Pe=v.gy;const ne=n();De=o.trunkCount>=0?Math.round(o.trunkCount):ne<.2?0:ne<.8?1:2,Fe=p(v.fx+(n()-.5)*.25,.05,.95),Ge=p(v.fx+(n()-.5)*.5,.05,.95),_e=.008+n()*n()*.03;const M=o.rootOffset,dt=(c,f)=>{const h=.1+f*.45,k=p(v.fx+(n()-.5)*h,.04,.96);if(c===2)return[k*t,1+M,-Math.PI/2+(n()-.5)*.6];if(c===3)return[k*t,-M,Math.PI/2+(n()-.5)*.6];const R=v.top?.7:.3,S=p(R+(n()-.5)*h,.05,.95);return c===0?[-M,S,(n()-.5)*.6]:[t+M,S,Math.PI+(n()-.5)*.6]},Ce=Math.max(1,Math.round(o.nTrees));for(let c=0;c<Ce&&!(d.length>=U);c++){const f=v.edges[c%v.edges.length],h=Ce>1?c/(Ce-1):0,k=p(.12+h*.4+(n()-.5)*.1,.04,.95),[R,S,X]=dt(f,h),oe=o.trunkWidth*(1-h*.5)*(.9+n()*.2);T(R,S,X,oe,(n()-.5)*o.curl,n()*Math.PI*2,k)}ce=Math.min(d.length,U),D=t+2;const A=(c,f)=>{const h=Math.max(0,Math.min(65535,Math.round(c*65535)));q[f]=h>>8&255,q[f+1]=h&255};q.fill(0);for(let c=0;c<ce;c++){const f=d[c],h=c*ue*4;A((f[0]+1)/D,h),A((f[1]+1)/D,h+2),A((f[2]+1)/D,h+4),A((f[3]+1)/D,h+6),A(f[4]/de,h+8),A(f[5]/de,h+10),A(f[6],h+12)}e.bindTexture(e.TEXTURE_2D,$),e.texImage2D(e.TEXTURE_2D,0,e.RGBA,ue,U,0,e.RGBA,e.UNSIGNED_BYTE,q)};let V=P("--komorebi-light"),Y=P("--komorebi-mid"),j=P("--komorebi-shadow"),Be=at("--secondary");const B=window.matchMedia("(prefers-reduced-motion: reduce)").matches,Oe=2;let fe=600,he=180,O=200,F=60;const We=()=>{[fe,he]=vt(m),O=Math.max(1,Math.round(fe/Oe)),F=Math.max(1,Math.round(he/Oe)),i.width=O,i.height=F,i.style.width=fe+"px",i.style.height=he+"px",e.viewport(0,0,O,F),Ue()};We();const Ne=new ResizeObserver(()=>{We(),B&&W()});Ne.observe(m);const Ie=()=>{V=P("--komorebi-light"),Y=P("--komorebi-mid"),j=P("--komorebi-shadow"),r.center=ot("--komorebi-center",.38),Be=at("--secondary"),B&&W()};document.addEventListener("themechange",Ie);let z=r.rest,G=r.rest,me=0,pe=0,He=0,qe=0,ge=0;const $e=t=>{const a=t.timeStamp;if(ge){const n=a-ge;if(n>0){const d=Math.hypot(t.clientX-He,t.clientY-qe)/n;G=Math.min(1,Math.max(G,d/r.sensitivity))}}He=t.clientX,qe=t.clientY,ge=a,pe=(t.clientX/window.innerWidth-.5)*2};window.addEventListener("pointermove",$e,{passive:!0});const Ve=t=>{t.gamma!=null&&(pe=Math.max(-1,Math.min(1,t.gamma/35)))};window.addEventListener("deviceorientation",Ve);const st=t=>.7+.3*(.65*Math.sin(t*.27*r.gustSpeed)+.35*Math.sin(t*.13*r.gustSpeed+2)),Ye=[.97,.22],_=["trunk","branches","(unused)","leaves"],be=[0,.05,.1,.36],ve=[0,.03,.08,.42],xe=[0,.7,1.5,3.2],lt=[0,1,2.4,3.9],ye=new Float32Array(8),y=document.createElement("div");y.className="dappled-debug",y.style.display="none";const je=(t,a,n)=>{const d=document.createElement("div");d.className="dappled-chart";const w=document.createElement("span");d.appendChild(w);const p=document.createElement("canvas");p.width=206,p.height=30,d.appendChild(p);const x=p.getContext("2d"),E=p.width,b=new Float32Array(E);let T=0;return{wrap:d,update:te=>{b[T]=te,T=(T+1)%E,w.textContent=`${t}: ${te.toFixed(n)}`,x.clearRect(0,0,E,p.height),x.beginPath();for(let v=0;v<E;v++){const ne=Math.min(b[(T+v)%E],a),M=p.height-1-ne/a*(p.height-2);v===0?x.moveTo(v,M):x.lineTo(v,M)}x.strokeStyle=`rgb(${Be})`,x.lineWidth=1,x.stroke()}}},ze=je("fps",80,0),Ke=je("wind",1,2);y.appendChild(ze.wrap),y.appendChild(Ke.wrap);const K=t=>{const a=document.createElement("div");a.className="dappled-debug-h",a.textContent=t,y.appendChild(a)},s=(t,a,n,d,w,p)=>{const x=document.createElement("label"),E=document.createElement("span"),b=document.createElement("input");b.type="range",b.min=String(a),b.max=String(n),b.step=String(d),b.value=String(w());const T=()=>E.textContent=`${t}: ${(+b.value).toFixed(2)}`;T(),b.addEventListener("input",()=>{p(parseFloat(b.value)),T()}),x.append(E,b),y.appendChild(x)},Qe=(t,a,n)=>{const d=document.createElement("label");d.className="dappled-debug-toggle";const w=document.createElement("input");w.type="checkbox",w.checked=a(),w.addEventListener("change",()=>n(w.checked));const p=document.createElement("span");p.textContent=t,d.append(w,p),y.appendChild(d)},ut=(t,a)=>{const n=document.createElement("button");n.className="dappled-debug-btn",n.textContent=t,n.addEventListener("click",a),y.appendChild(n)},g=()=>{Ue(),B&&W()};K("wind"),s("cursor sensitivity",1,15,.5,()=>r.sensitivity,t=>r.sensitivity=t),s("resting wind",0,1,.01,()=>r.rest,t=>r.rest=t),s("gust speed",.2,3,.05,()=>r.gustSpeed,t=>r.gustSpeed=t),K("branches");for(let t=0;t<4;t++){const a=t;a!==2&&(Qe(_[a],()=>r.layerOn[a]>.5,n=>r.layerOn[a]=n?1:0),s(`${_[a]} blur`,0,1,.02,()=>r.blur[a],n=>r.blur[a]=n),a<3&&s(`${_[a]} floor max`,0,1,.02,()=>r.floor[a],n=>r.floor[a]=n),s(`${_[a]} bend`,0,.5,.005,()=>be[a],n=>be[a]=n),s(`${_[a]} flutter`,0,.5,.005,()=>ve[a],n=>ve[a]=n),s(`${_[a]} flutter spd`,0,5,.1,()=>xe[a],n=>xe[a]=n))}K("tree (L-system)"),ut("reshuffle tree",()=>{Xe=Math.floor(Math.random()*1e9),g()}),s("scene (-1=rand)",-1,4,1,()=>o.sceneType,t=>{o.sceneType=t,g()}),s("root offset",0,1.6,.02,()=>o.rootOffset,t=>{o.rootOffset=t,g()}),s("trunks (-1=rand)",-1,2,1,()=>o.trunkCount,t=>{o.trunkCount=t,g()}),s("leaf bias",0,3,.05,()=>o.leafBias,t=>{o.leafBias=t}),s("leaf follows depth",0,1,.05,()=>o.leafFollow,t=>{o.leafFollow=t}),s("trees",1,12,1,()=>o.nTrees,t=>{o.nTrees=t,g()}),s("trunk width",.02,.09,.002,()=>o.trunkWidth,t=>{o.trunkWidth=t,g()}),s("len / width",4,28,.5,()=>o.lenRatio,t=>{o.lenRatio=t,g()}),s("max seg len",.06,.7,.01,()=>o.maxLen,t=>{o.maxLen=t,g()}),s("curl",0,.8,.02,()=>o.curl,t=>{o.curl=t,g()}),s("P(3 split)",0,1,.05,()=>o.split3,t=>{o.split3=t,g()}),s("fork prob",.3,1,.05,()=>o.forkProb,t=>{o.forkProb=t,g()}),s("depth drift",0,.9,.05,()=>o.depthDrift,t=>{o.depthDrift=t,g()}),s("leader share",.4,.95,.02,()=>o.leader,t=>{o.leader=t,g()}),s("golden phyllotaxis",0,1,.05,()=>o.golden,t=>{o.golden=t,g()}),s("width conserve",.7,1,.01,()=>o.conserve,t=>{o.conserve=t,g()}),s("end thickness px",.5,3,.1,()=>o.endPx,t=>{o.endPx=t,g()}),K("tone & dither"),Qe("dither",()=>r.dither>.5,t=>r.dither=t?1:0),s("contrast",.5,3,.05,()=>r.contrast,t=>r.contrast=t),s("brightness",.1,.7,.01,()=>r.center,t=>r.center=t),s("gold start",0,.8,.01,()=>r.goldLo,t=>r.goldLo=t),s("gold end",.2,.95,.01,()=>r.goldHi,t=>r.goldHi=t),s("canopy",0,1.5,.05,()=>r.canopy,t=>r.canopy=t),document.body.appendChild(y);const Q=["ArrowUp","ArrowUp","ArrowDown","ArrowDown","ArrowLeft","ArrowRight","ArrowLeft","ArrowRight"];let L=[];const Je=t=>{L.push(t.key),L.length>Q.length&&(L=L.slice(-Q.length)),L.length===Q.length&&Q.every((a,n)=>L[n]===a)&&(y.style.display=y.style.display==="none"?"block":"none",L=[])};document.addEventListener("keydown",Je);let J=0,we=r.rest;const W=()=>{e.uniform1f(u.uTime,J),e.uniform2f(u.uResolution,O,F),e.uniform2fv(u.uDisp,ye),e.uniform3f(u.uColorA,V[0],V[1],V[2]),e.uniform3f(u.uColorMid,Y[0],Y[1],Y[2]),e.uniform3f(u.uColorB,j[0],j[1],j[2]),e.uniform1f(u.uContrast,r.contrast),e.uniform1f(u.uCenter,r.center),e.uniform1f(u.uGoldLo,r.goldLo),e.uniform1f(u.uGoldHi,r.goldHi),e.uniform1f(u.uCanopy,r.canopy),e.uniform4f(u.uLayerOn,r.layerOn[0],r.layerOn[1],r.layerOn[2],r.layerOn[3]),e.uniform4f(u.uBlur,r.blur[0],r.blur[1],r.blur[2],r.blur[3]),e.uniform1f(u.uDither,r.dither),e.uniform1f(u.uParallax,me),e.uniform3f(u.uFloor,r.floor[0],r.floor[1],r.floor[2]),e.activeTexture(e.TEXTURE0),e.bindTexture(e.TEXTURE_2D,$),e.uniform1i(u.uSegTex,0),e.uniform1f(u.uPosScale,D),e.uniform1f(u.uWidScale,de),e.uniform1i(u.uSegCount,ce),e.uniform2f(u.uLeafGrad,Re,Pe),e.uniform1f(u.uLeafFall,o.leafBias),e.uniform1f(u.uLeafFollow,o.leafFollow),e.uniform1f(u.uTrunkCount,De),e.uniform2f(u.uTrunkX,Fe,Ge),e.uniform1f(u.uTrunkW,_e),e.drawArrays(e.TRIANGLES,0,3)};let N=0,Z=!0,ee=0,Te=0;const Ee=t=>{const a=ee?Math.min(.05,(t-ee)/1e3):.016;ee=t,J+=a,G=Math.max(r.rest,G*.97),z+=(G-z)*(G>z?.02:.05),me+=(pe-me)*.08,we=st(J)*z;let n=0;for(let d=0;d<4;d++)n+=we*(be[d]+ve[d]*Math.sin(J*xe[d]+lt[d])),ye[2*d]=Ye[0]*n,ye[2*d+1]=Ye[1]*n;W(),Te+=((a>0?1/a:0)-Te)*.1,y.style.display!=="none"&&(ze.update(Te),Ke.update(we)),Z&&(N=requestAnimationFrame(Ee))},Ze=()=>{document.hidden?(Z=!1,cancelAnimationFrame(N)):B||(Z=!0,ee=0,N=requestAnimationFrame(Ee))};B?W():(N=requestAnimationFrame(Ee),document.addEventListener("visibilitychange",Ze)),window.addCleanup(()=>{Z=!1,cancelAnimationFrame(N),Ne.disconnect(),window.removeEventListener("pointermove",$e),window.removeEventListener("deviceorientation",Ve),document.removeEventListener("themechange",Ie),document.removeEventListener("visibilitychange",Ze),document.removeEventListener("keydown",Je),y.remove(),e.deleteTexture($),e.getExtension("WEBGL_lose_context")?.loseContext(),i.remove()})}document.addEventListener("nav",()=>{const m=document.querySelector(".dappled-scene");!m||m.dataset.init==="true"||(m.dataset.init="true",xt(m))});
