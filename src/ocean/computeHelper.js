// M0: mechanisch uit index.html v7 geextraheerd, gedrag ongewijzigd.
// M1.9: dispatch-tellers en waarneembaarheid. "Stille no-op" dispatches hebben dit project
//       twee keer dagen gekost; vanaf nu is elke dispatch telbaar en elke weigering gelogd.
import { WGSL } from './wgsl.js';
import { pushLog } from '../core/log.js';

export const ComputeHelper = {
  _threadGroupCache: new WeakMap(),

  GetThreadGroupSizes(source, entryPoint) {
    const rx = new RegExp(`workgroup_size\\s*\\(\\s*(\\d+)\\s*,\\s*(\\d+)\\s*,\\s*(\\d+)\\s*\\)\\s*fn\\s+${entryPoint}\\s*\\(`, 'g');
    const res = rx.exec(source);
    return res ? new BABYLON.Vector3(parseInt(res[1]), parseInt(res[2]), parseInt(res[3])) : new BABYLON.Vector3(8,8,1);
  },

  CreateStorageTexture(name, engine, w, h, format, type, samplingMode, generateMipMaps) {
    format = format ?? BABYLON.Constants.TEXTUREFORMAT_RGBA;
    type   = type   ?? BABYLON.Constants.TEXTURETYPE_FLOAT;
    samplingMode = samplingMode ?? BABYLON.Constants.TEXTURE_NEAREST_SAMPLINGMODE;
    const tex = new BABYLON.RawTexture(null, w, h, format, engine, generateMipMaps || false, false,
      samplingMode, type, BABYLON.Constants.TEXTURE_CREATIONFLAG_STORAGE);
    tex.name = name;
    tex.wrapU = tex.wrapV = BABYLON.Constants.TEXTURE_WRAP_ADDRESSMODE;
    return tex;
  },

  Dispatch(cs, nx, ny, nz) {
    if (!cs.__tgs) cs.__tgs = ComputeHelper.GetThreadGroupSizes(cs.shaderPath.computeSource, cs.options.entryPoint || 'main');
    const tgs = cs.__tgs;
    const gx = Math.ceil(nx / tgs.x);
    const gy = Math.ceil((ny||1) / tgs.y);
    const gz = Math.ceil((nz||1) / tgs.z);
    const ok = cs.dispatch(gx, gy, gz);
    // M1.9: dispatch() retourneert false zolang de shader niet gecompileerd is (stille no-op
    // op v9). Per-frame dispatches herhalen vanzelf, maar de eerste weigering wordt nu
    // eenmalig gelogd zodat een hangende compilatie nooit meer onzichtbaar is.
    // M1.14: op info-niveau i.p.v. warn. Dit is verwacht gedrag tijdens de opstart (WGSL
    // compileert asynchroon); een warning suggereerde ten onrechte een probleem. De echte
    // faalmodus (compilatie die NOOIT klaarkomt) is nu juist beter zichtbaar: de
    // ready-melding blijft dan uit terwijl de wachtmelding er wel staat.
    if (ok === false) {
      if (!cs.__zbNotReadyWarned) { cs.__zbNotReadyWarned = true; pushLog('COMPUTE', `dispatch '${cs.name}' wacht op WGSL-compilatie (herhaalt per frame)`, false); }
    } else {
      if (cs.__zbNotReadyWarned && !cs.__zbReadyLogged) { cs.__zbReadyLogged = true; pushLog('COMPUTE', `'${cs.name}' gecompileerd, dispatches lopen`, false); }
      cs.__zbDispatched = (cs.__zbDispatched | 0) + 1;
    }
  },

  // v9-fix: dispatch() vóór WGSL-compilatie is een stille no-op. dispatchWhenReady wacht
  // op compilatie en vuurt dan. Gebruikt voor de eenmalige spectrum-bake. Retourneert een Promise.
  // M1.9: telt de daadwerkelijke dispatch, zodat de probe "nooit gedispatcht" van
  // "gedispatcht maar output nul" kan onderscheiden.
  DispatchWhenReady(cs, nx, ny, nz) {
    if (!cs.__tgs) cs.__tgs = ComputeHelper.GetThreadGroupSizes(cs.shaderPath.computeSource, cs.options.entryPoint || 'main');
    const tgs = cs.__tgs;
    const gx = Math.ceil(nx / tgs.x);
    const gy = Math.ceil((ny||1) / tgs.y);
    const gz = Math.ceil((nz||1) / tgs.z);
    const p = cs.dispatchWhenReady ? cs.dispatchWhenReady(gx, gy, gz) : (cs.dispatch(gx, gy, gz), Promise.resolve());
    return Promise.resolve(p).then(() => { cs.__zbDispatched = (cs.__zbDispatched | 0) + 1; });
  },

  CopyTexture(source, dest, engine) {
    if (!ComputeHelper.__copyCS) {
      const cs = new BABYLON.ComputeShader('copyTex2', engine, { computeSource: WGSL.copyTexture2 }, {
        bindingsMapping: { dest:{group:0,binding:0}, src:{group:0,binding:1}, params:{group:0,binding:2} }
      });
      const ub = new BABYLON.UniformBuffer(engine);
      ub.addUniform('width',1); ub.addUniform('height',1);
      cs.setUniformBuffer('params', ub);
      ComputeHelper.__copyCS = cs;
      ComputeHelper.__copyParams = ub;
    }
    const cs = ComputeHelper.__copyCS, ub = ComputeHelper.__copyParams;
    cs.setTexture('src', source, false);
    cs.setStorageTexture('dest', dest);
    const { width, height } = source.getSize();
    ub.updateInt('width', width); ub.updateInt('height', height); ub.update();
    ComputeHelper.Dispatch(cs, width, height, 1);
  }
};
