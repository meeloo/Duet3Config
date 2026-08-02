// Raw WebGL2 toolpath renderer.
//
// No three.js. A toolpath is one large line buffer with no lighting, materials
// or scene graph, so nearly everything a general 3D engine provides would go
// unused — the only real work it saves is orbit controls, which are ~60 lines.
//
// Colouring is done in the fragment shader from a per-vertex source byte offset
// compared against a `progress` uniform, so advancing the cut/uncut boundary as
// the job runs costs one uniform write per frame rather than a buffer rebuild.

import { lookAt, multiply, perspective, type Mat4 } from './mat4.js';
import type { ParsedToolpath } from './parse.js';

const VERT = `#version 300 es
precision highp float;
in vec3 aPos;
in float aOffset;
in float aKind;
uniform mat4 uMvp;
out float vOffset;
out float vKind;
void main() {
  vOffset = aOffset;
  vKind = aKind;
  gl_Position = uMvp * vec4(aPos, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;
in float vOffset;
in float vKind;
uniform float uProgress;
uniform int uShowRapids;
uniform vec3 uCutColor;
uniform vec3 uDoneColor;
uniform vec3 uRapidColor;
out vec4 outColor;
void main() {
  bool rapid = vKind < 0.5;
  if (rapid && uShowRapids == 0) discard;
  vec3 c;
  float a;
  if (rapid) {
    c = uRapidColor;
    a = 0.35;
  } else if (uProgress >= 0.0 && vOffset <= uProgress) {
    c = uDoneColor;
    a = 1.0;
  } else {
    c = uCutColor;
    a = 0.9;
  }
  outColor = vec4(c, a);
}`;

const OVERLAY_VERT = `#version 300 es
precision highp float;
in vec3 aPos;
in vec3 aColor;
uniform mat4 uMvp;
out vec3 vColor;
void main() {
  vColor = aColor;
  gl_Position = uMvp * vec4(aPos, 1.0);
}`;

const OVERLAY_FRAG = `#version 300 es
precision highp float;
in vec3 vColor;
out vec4 outColor;
void main() { outColor = vec4(vColor, 1.0); }`;

export interface CameraState {
  azimuth: number;
  elevation: number;
  distance: number;
  target: [number, number, number];
}

export class ToolpathRenderer {
  private gl: WebGL2RenderingContext;
  private program: WebGLProgram;
  private overlayProgram: WebGLProgram;

  private vao: WebGLVertexArrayObject | null = null;
  private posBuffer: WebGLBuffer | null = null;
  private offsetBuffer: WebGLBuffer | null = null;
  private kindBuffer: WebGLBuffer | null = null;
  private vertexCount = 0;

  private overlayVao: WebGLVertexArrayObject;
  private overlayPos: WebGLBuffer;
  private overlayColor: WebGLBuffer;
  private overlayCount = 0;

  private uMvp: WebGLUniformLocation | null;
  private uProgress: WebGLUniformLocation | null;
  private uShowRapids: WebGLUniformLocation | null;
  private uCutColor: WebGLUniformLocation | null;
  private uDoneColor: WebGLUniformLocation | null;
  private uRapidColor: WebGLUniformLocation | null;
  private uOverlayMvp: WebGLUniformLocation | null;

  camera: CameraState = {
    azimuth: -Math.PI / 4,
    elevation: Math.PI / 5,
    distance: 400,
    target: [0, 0, 0],
  };

  showRapids = true;
  progress = -1;

  constructor(private canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', {
      antialias: true,
      alpha: true,
      preserveDrawingBuffer: false,
    });
    if (!gl) throw new Error('WebGL2 is not available in this browser');
    this.gl = gl;

    this.program = link(gl, VERT, FRAG);
    this.overlayProgram = link(gl, OVERLAY_VERT, OVERLAY_FRAG);

    this.uMvp = gl.getUniformLocation(this.program, 'uMvp');
    this.uProgress = gl.getUniformLocation(this.program, 'uProgress');
    this.uShowRapids = gl.getUniformLocation(this.program, 'uShowRapids');
    this.uCutColor = gl.getUniformLocation(this.program, 'uCutColor');
    this.uDoneColor = gl.getUniformLocation(this.program, 'uDoneColor');
    this.uRapidColor = gl.getUniformLocation(this.program, 'uRapidColor');
    this.uOverlayMvp = gl.getUniformLocation(this.overlayProgram, 'uMvp');

    this.overlayVao = gl.createVertexArray()!;
    this.overlayPos = gl.createBuffer()!;
    this.overlayColor = gl.createBuffer()!;
    // Query the linked locations rather than assuming 0/1 — the GL
    // implementation is free to assign them however it likes.
    const oPos = gl.getAttribLocation(this.overlayProgram, 'aPos');
    const oColor = gl.getAttribLocation(this.overlayProgram, 'aColor');
    gl.bindVertexArray(this.overlayVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.overlayPos);
    gl.enableVertexAttribArray(oPos);
    gl.vertexAttribPointer(oPos, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.overlayColor);
    gl.enableVertexAttribArray(oColor);
    gl.vertexAttribPointer(oColor, 3, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
  }

  /** Upload a parsed toolpath and frame the camera on it. */
  setToolpath(path: ParsedToolpath): void {
    const gl = this.gl;
    this.dispose(false);

    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);

    this.posBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, path.positions, gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(this.program, 'aPos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 0, 0);

    this.offsetBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.offsetBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, path.offsets, gl.STATIC_DRAW);
    const aOffset = gl.getAttribLocation(this.program, 'aOffset');
    gl.enableVertexAttribArray(aOffset);
    gl.vertexAttribPointer(aOffset, 1, gl.FLOAT, false, 0, 0);

    // Kind is a byte per vertex; upload as float to keep the shader simple.
    this.kindBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.kindBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, Float32Array.from(path.kinds), gl.STATIC_DRAW);
    const aKind = gl.getAttribLocation(this.program, 'aKind');
    gl.enableVertexAttribArray(aKind);
    gl.vertexAttribPointer(aKind, 1, gl.FLOAT, false, 0, 0);

    gl.bindVertexArray(null);
    this.vertexCount = path.positions.length / 3;

    this.frame(path);
  }

  /** Point the camera at the whole toolpath. */
  frame(path: ParsedToolpath): void {
    const cx = (path.min[0] + path.max[0]) / 2;
    const cy = (path.min[1] + path.max[1]) / 2;
    const cz = (path.min[2] + path.max[2]) / 2;
    const span = Math.max(
      path.max[0] - path.min[0],
      path.max[1] - path.min[1],
      path.max[2] - path.min[2],
      10,
    );
    this.camera.target = [cx, cy, cz];
    this.camera.distance = span * 1.8;
  }

  /**
   * Overlay geometry: origin axes, the machine's work envelope, and a crosshair
   * at the current cutter position. Rebuilt per frame — it is a handful of
   * vertices, so there is nothing to gain from caching it.
   */
  setOverlay(
    cutter: [number, number, number] | null,
    bounds: { min: [number, number, number]; max: [number, number, number] } | null,
  ): void {
    const pos: number[] = [];
    const col: number[] = [];

    const seg = (
      a: [number, number, number],
      b: [number, number, number],
      c: [number, number, number],
    ) => {
      pos.push(...a, ...b);
      col.push(...c, ...c);
    };

    // Work origin marker.
    const axisLen = bounds
      ? Math.max(bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1], 20) * 0.08
      : 20;
    seg([0, 0, 0], [axisLen, 0, 0], [0.85, 0.25, 0.25]);
    seg([0, 0, 0], [0, axisLen, 0], [0.35, 0.75, 0.35]);
    seg([0, 0, 0], [0, 0, axisLen], [0.35, 0.55, 0.9]);

    if (bounds) {
      const [x0, y0, z0] = bounds.min;
      const [x1, y1, z1] = bounds.max;
      const c: [number, number, number] = [0.3, 0.3, 0.36];
      // Bottom rectangle, top rectangle, verticals.
      const corners: Array<[number, number]> = [
        [x0, y0],
        [x1, y0],
        [x1, y1],
        [x0, y1],
      ];
      for (let i = 0; i < 4; i++) {
        const [ax, ay] = corners[i];
        const [bx, by] = corners[(i + 1) % 4];
        seg([ax, ay, z0], [bx, by, z0], c);
        seg([ax, ay, z1], [bx, by, z1], c);
        seg([ax, ay, z0], [ax, ay, z1], c);
      }
    }

    if (cutter) {
      const [x, y, z] = cutter;
      const s = axisLen * 0.6;
      const c: [number, number, number] = [1.0, 0.75, 0.15];
      seg([x - s, y, z], [x + s, y, z], c);
      seg([x, y - s, z], [x, y + s, z], c);
      seg([x, y, z], [x, y, z + s * 2], c);
    }

    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.overlayPos);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(pos), gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.overlayColor);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(col), gl.DYNAMIC_DRAW);
    this.overlayCount = pos.length / 3;
  }

  private mvp(): Mat4 {
    const { azimuth, elevation, distance, target } = this.camera;
    // Z-up, matching the machine's own frame — a CNC operator thinks in Z-up,
    // and matching it means the overlay axes read the way the DRO does.
    const eye: [number, number, number] = [
      target[0] + distance * Math.cos(elevation) * Math.cos(azimuth),
      target[1] + distance * Math.cos(elevation) * Math.sin(azimuth),
      target[2] + distance * Math.sin(elevation),
    ];
    const aspect = this.canvas.width / Math.max(1, this.canvas.height);
    const proj = perspective(Math.PI / 4, aspect, Math.max(0.1, distance / 100), distance * 10);
    const view = lookAt(eye, target, [0, 0, 1]);
    return multiply(proj, view);
  }

  resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.floor(this.canvas.clientWidth * dpr));
    const h = Math.max(1, Math.floor(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  render(): void {
    const gl = this.gl;
    this.resize();
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0.07, 0.08, 0.10, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    const mvp = this.mvp();

    if (this.vao && this.vertexCount) {
      gl.useProgram(this.program);
      gl.uniformMatrix4fv(this.uMvp, false, mvp);
      gl.uniform1f(this.uProgress, this.progress);
      gl.uniform1i(this.uShowRapids, this.showRapids ? 1 : 0);
      gl.uniform3f(this.uCutColor, 0.55, 0.78, 1.0);
      gl.uniform3f(this.uDoneColor, 0.35, 0.85, 0.45);
      gl.uniform3f(this.uRapidColor, 0.6, 0.6, 0.7);
      gl.bindVertexArray(this.vao);
      gl.drawArrays(gl.LINES, 0, this.vertexCount);
    }

    if (this.overlayCount) {
      gl.useProgram(this.overlayProgram);
      gl.uniformMatrix4fv(this.uOverlayMvp, false, mvp);
      gl.bindVertexArray(this.overlayVao);
      gl.drawArrays(gl.LINES, 0, this.overlayCount);
    }

    gl.bindVertexArray(null);
  }

  dispose(full = true): void {
    const gl = this.gl;
    if (this.vao) gl.deleteVertexArray(this.vao);
    if (this.posBuffer) gl.deleteBuffer(this.posBuffer);
    if (this.offsetBuffer) gl.deleteBuffer(this.offsetBuffer);
    if (this.kindBuffer) gl.deleteBuffer(this.kindBuffer);
    this.vao = null;
    this.posBuffer = this.offsetBuffer = this.kindBuffer = null;
    this.vertexCount = 0;

    if (full) {
      gl.deleteVertexArray(this.overlayVao);
      gl.deleteBuffer(this.overlayPos);
      gl.deleteBuffer(this.overlayColor);
      gl.deleteProgram(this.program);
      gl.deleteProgram(this.overlayProgram);
    }
  }
}

function link(gl: WebGL2RenderingContext, vertSrc: string, fragSrc: string): WebGLProgram {
  const compile = (type: number, src: string): WebGLShader => {
    const sh = gl.createShader(type)!;
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const info = gl.getShaderInfoLog(sh);
      gl.deleteShader(sh);
      throw new Error(`shader compile failed: ${info}`);
    }
    return sh;
  };

  const vs = compile(gl.VERTEX_SHADER, vertSrc);
  const fs = compile(gl.FRAGMENT_SHADER, fragSrc);
  const program = gl.createProgram()!;
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const info = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`program link failed: ${info}`);
  }
  return program;
}
