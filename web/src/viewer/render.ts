// Raw WebGL2 toolpath renderer.
//
// No three.js. A toolpath is one large line buffer with no lighting, materials
// or scene graph, so nearly everything a general 3D engine provides would go
// unused — the only real work it saves is orbit controls, which are ~60 lines.
//
// Colouring is done in the fragment shader from a per-vertex source byte offset
// compared against a `progress` uniform, so advancing the cut/uncut boundary as
// the job runs costs one uniform write per frame rather than a buffer rebuild.

import { lookAt, multiply, ortho, perspective, type Mat4 } from './mat4.js';
import type { ParsedToolpath } from './parse.js';
import { viewerPalette, type ViewerPalette } from '../core/theme.js';
import type { ToolShape } from '../tools/shape.js';

/** An axis-aligned box in work coordinates. */
export interface Box {
  min: [number, number, number];
  max: [number, number, number];
}

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
uniform float uRapidAlpha;
out vec4 outColor;
void main() {
  bool rapid = vKind < 0.5;
  if (rapid && uShowRapids == 0) discard;
  vec3 c;
  float a;
  if (rapid) {
    c = uRapidColor;
    // Alpha comes from the palette: a light background needs far more opacity
    // than a dark one for the same apparent contrast.
    a = uRapidAlpha;
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

export type Projection = 'perspective' | 'ortho';

export type ViewName = 'home' | 'top' | 'front' | 'back' | 'left' | 'right' | 'iso';

/**
 * Named camera angles, as (azimuth, elevation) in radians.
 *
 * `home` is a shallow look down the long axis from the front — on a bed that is
 * 2.4x longer than it is wide, a steeper angle wastes most of the viewport on
 * empty table. Straight-down and dead-on views are nudged a hair off their
 * exact angle so the floor grid and the envelope walls don't degenerate into a
 * single line and vanish.
 */
export const VIEWS: Record<ViewName, { azimuth: number; elevation: number }> = {
  home: { azimuth: -Math.PI / 2 - 0.14, elevation: 0.42 },
  top: { azimuth: -Math.PI / 2, elevation: Math.PI / 2 - 0.001 },
  front: { azimuth: -Math.PI / 2, elevation: 0.02 },
  back: { azimuth: Math.PI / 2, elevation: 0.02 },
  left: { azimuth: Math.PI, elevation: 0.02 },
  right: { azimuth: 0, elevation: 0.02 },
  // True isometric: atan(1/sqrt(2)) elevation.
  iso: { azimuth: -Math.PI / 4, elevation: Math.atan(1 / Math.SQRT2) },
};

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
  private uRapidAlpha: WebGLUniformLocation | null;
  private uOverlayMvp: WebGLUniformLocation | null;

  camera: CameraState = {
    ...VIEWS.home,
    distance: 400,
    target: [0, 0, 0],
  };

  projection: Projection = 'perspective';
  showRapids = true;
  progress = -1;
  palette: ViewerPalette = viewerPalette();

  /** Point the camera along a named view, keeping the current target and zoom. */
  setView(name: ViewName): void {
    const v = VIEWS[name];
    this.camera.azimuth = v.azimuth;
    this.camera.elevation = v.elevation;
  }

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
    this.uRapidAlpha = gl.getUniformLocation(this.program, 'uRapidAlpha');
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

  /** Point the camera at a box — a toolpath's bounds or the machine envelope. */
  frame(box: Box): void {
    const cx = (box.min[0] + box.max[0]) / 2;
    const cy = (box.min[1] + box.max[1]) / 2;
    const cz = (box.min[2] + box.max[2]) / 2;
    const span = Math.max(
      box.max[0] - box.min[0],
      box.max[1] - box.min[1],
      box.max[2] - box.min[2],
      10,
    );
    this.camera.target = [cx, cy, cz];
    this.camera.distance = span * 1.8;
  }

  /**
   * Overlay geometry: work origin, the machine's travel envelope with a floor
   * grid, the loaded toolpath's bounding box, and a crosshair at the cutter.
   * Rebuilt per frame — it is a few hundred vertices, so caching buys nothing.
   *
   * Everything here is in WORK coordinates. The envelope arrives already
   * converted by the caller, because the axis limits the controller reports are
   * in machine coordinates and the toolpath is not.
   *
   * `tool` arrives tip-at-the-origin and is placed at the cutter, which is what
   * makes it follow a scrubbed cursor as readily as the live spindle.
   */
  setOverlay(
    cutter: [number, number, number] | null,
    bounds: Box | null,
    envelope: Box | null = null,
    tool: ToolShape | null = null,
  ): void {
    const pos: number[] = [];
    const col: number[] = [];
    const p = this.palette;

    const seg = (
      a: [number, number, number],
      b: [number, number, number],
      c: [number, number, number],
    ) => {
      pos.push(...a, ...b);
      col.push(...c, ...c);
    };

    const wire = (box: Box, c: [number, number, number]) => {
      const [x0, y0, z0] = box.min;
      const [x1, y1, z1] = box.max;
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
    };

    // Scale the origin marker to whatever is on screen.
    const ref = envelope ?? bounds;
    const axisLen = ref
      ? Math.max(ref.max[0] - ref.min[0], ref.max[1] - ref.min[1], 20) * 0.05
      : 20;

    if (envelope) {
      // Floor grid at the envelope's bottom, at a round spacing that keeps the
      // line count sane on a 1500mm bed.
      const w = envelope.max[0] - envelope.min[0];
      const h = envelope.max[1] - envelope.min[1];
      const step = gridStep(Math.max(w, h));
      const z = envelope.min[2];

      const startX = Math.ceil(envelope.min[0] / step) * step;
      for (let x = startX; x <= envelope.max[0]; x += step) {
        seg([x, envelope.min[1], z], [x, envelope.max[1], z], p.grid);
      }
      const startY = Math.ceil(envelope.min[1] / step) * step;
      for (let y = startY; y <= envelope.max[1]; y += step) {
        seg([envelope.min[0], y, z], [envelope.max[0], y, z], p.grid);
      }

      wire(envelope, p.envelope);
    }

    if (bounds) wire(bounds, p.bounds);

    // Work origin last so it draws over the grid.
    seg([0, 0, 0], [axisLen, 0, 0], p.axisX);
    seg([0, 0, 0], [0, axisLen, 0], p.axisY);
    seg([0, 0, 0], [0, 0, axisLen], p.axisZ);

    if (cutter) {
      const [x, y, z] = cutter;
      const s = axisLen * 0.6;
      seg([x - s, y, z], [x + s, y, z], p.cutter);
      seg([x, y - s, z], [x, y + s, z], p.cutter);
      // With the tool drawn, the vertical whisker would run up inside it and be
      // the only thing visible when zoomed in close. The cross alone still
      // marks the tip, which is all it was ever for.
      if (!tool) seg([x, y, z], [x, y, z + s * 2], p.cutter);

      if (tool) {
        const v = tool.vertices;
        for (let i = 0; i < v.length; i += 3) {
          pos.push(v[i] + x, v[i + 1] + y, v[i + 2] + z);
          col.push(...(tool.kinds[i / 3] ? p.toolShank : p.tool));
        }
      }
    }

    if (this.resumeMarker) {
      // A diagonal cross, so it reads as distinct from the cutter crosshair
      // even when the two happen to land on top of each other.
      const [x, y, z] = this.resumeMarker;
      const s = axisLen * 0.7;
      seg([x - s, y - s, z], [x + s, y + s, z], p.resume);
      seg([x - s, y + s, z], [x + s, y - s, z], p.resume);
      seg([x, y, z], [x, y, z + s * 3], p.resume);
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
    // Orthographic keeps parallel edges parallel, which is what you want when
    // reading a toolpath for size; perspective reads better for shape. The
    // near/far planes are pushed well outside the scene because with no
    // foreshortening the eye can end up inside the model's bounding box.
    const proj =
      this.projection === 'ortho'
        ? (() => {
            const h = distance * 0.42;
            const w = h * aspect;
            return ortho(-w, w, -h, h, -distance * 10, distance * 10);
          })()
        : perspective(Math.PI / 4, aspect, Math.max(0.1, distance / 100), distance * 10);
    const view = lookAt(eye, target, [0, 0, 1]);
    return multiply(proj, view);
  }

  /**
   * Nearest toolpath vertex to a point on the canvas, for click-to-resume.
   *
   * Brute force over every vertex: one pass of ~180k points for a 3 MiB file is
   * a couple of milliseconds, which is nothing for a click, and it avoids
   * maintaining a spatial index that would have to be rebuilt on every load.
   *
   * @param px,py canvas-relative CSS pixels
   * @returns the source byte offset and world point, or null if nothing is near
   */
  pickNearest(
    px: number,
    py: number,
    path: ParsedToolpath,
    maxPixels = 24,
  ): { offset: number; point: [number, number, number] } | null {
    const mvp = this.mvp();
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (!w || !h) return null;

    let bestDist = maxPixels * maxPixels;
    let bestIndex = -1;

    const pos = path.positions;
    for (let i = 0; i < pos.length; i += 3) {
      const x = pos[i], y = pos[i + 1], z = pos[i + 2];
      const cw = mvp[3] * x + mvp[7] * y + mvp[11] * z + mvp[15];
      if (cw <= 0) continue; // behind the camera
      const cx = mvp[0] * x + mvp[4] * y + mvp[8] * z + mvp[12];
      const cy = mvp[1] * x + mvp[5] * y + mvp[9] * z + mvp[13];
      const sx = ((cx / cw + 1) / 2) * w;
      const sy = ((1 - cy / cw) / 2) * h;
      const dx = sx - px;
      const dy = sy - py;
      const d = dx * dx + dy * dy;
      if (d < bestDist) {
        bestDist = d;
        bestIndex = i;
      }
    }

    if (bestIndex < 0) return null;
    return {
      offset: path.offsets[bestIndex / 3],
      point: [pos[bestIndex], pos[bestIndex + 1], pos[bestIndex + 2]],
    };
  }

  /** Marker drawn at a chosen resume point, in work coordinates. */
  resumeMarker: [number, number, number] | null = null;

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
    const bg = this.palette.background;
    gl.clearColor(bg[0], bg[1], bg[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    const mvp = this.mvp();

    if (this.vao && this.vertexCount) {
      gl.useProgram(this.program);
      gl.uniformMatrix4fv(this.uMvp, false, mvp);
      gl.uniform1f(this.uProgress, this.progress);
      gl.uniform1i(this.uShowRapids, this.showRapids ? 1 : 0);
      gl.uniform3f(this.uCutColor, ...this.palette.cut);
      gl.uniform3f(this.uDoneColor, ...this.palette.done);
      gl.uniform3f(this.uRapidColor, ...this.palette.rapid);
      gl.uniform1f(this.uRapidAlpha, this.palette.rapidAlpha);
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

/** Round grid spacing giving roughly 10-30 lines across the larger dimension. */
function gridStep(span: number): number {
  const candidates = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500];
  for (const c of candidates) if (span / c <= 30) return c;
  return 1000;
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
