// webgl_renderer.ts — Высокопроизводительный WebGL рендерер для ECS частиц
// Рендерит до 1 000 000+ точек со скоростью 60 FPS прямо из колонок Position и Tint

export function createWebGLRenderer(canvas: HTMLCanvasElement, W: number, H: number) {
  const gl = canvas.getContext("webgl", {
    alpha: false,
    antialias: false,
    powerPreference: "high-performance",
    depth: false,
    stencil: false,
    preserveDrawingBuffer: false
  }) as WebGLRenderingContext | null;

  if (!gl) {
    throw new Error("WebGL не поддерживается браузером");
  }

  // 1. Шейдер частиц (gl.POINTS)
  const vsSource = `
    attribute float a_x;
    attribute float a_y;
    attribute vec4 a_color;

    uniform vec2 u_resolution;
    uniform float u_point_size;

    varying vec4 v_color;

    void main() {
      // Преобразование координат (0..W, 0..H) в WebGL Clip Space (-1.0 .. +1.0)
      vec2 zeroToOne = vec2(a_x, a_y) / u_resolution;
      vec2 clipSpace = zeroToOne * 2.0 - 1.0;
      gl_Position = vec4(clipSpace.x, -clipSpace.y, 0.0, 1.0);
      gl_PointSize = u_point_size;
      v_color = a_color;
    }
  `;

  const fsSource = `
    precision mediump float;
    varying vec4 v_color;

    void main() {
      gl_FragColor = v_color;
    }
  `;

  function createShader(glCtx: WebGLRenderingContext, type: number, source: string): WebGLShader {
    const shader = glCtx.createShader(type)!;
    glCtx.shaderSource(shader, source);
    glCtx.compileShader(shader);
    if (!glCtx.getShaderParameter(shader, glCtx.COMPILE_STATUS)) {
      const info = glCtx.getShaderInfoLog(shader);
      glCtx.deleteShader(shader);
      throw new Error("Ошибка компиляции шейдера: " + info);
    }
    return shader;
  }

  function createProgram(glCtx: WebGLRenderingContext, vs: string, fs: string): WebGLProgram {
    const program = glCtx.createProgram()!;
    const vert = createShader(glCtx, glCtx.VERTEX_SHADER, vs);
    const frag = createShader(glCtx, glCtx.FRAGMENT_SHADER, fs);
    glCtx.attachShader(program, vert);
    glCtx.attachShader(program, frag);
    glCtx.linkProgram(program);
    if (!glCtx.getProgramParameter(program, glCtx.LINK_STATUS)) {
      throw new Error("Ошибка линковки программы: " + glCtx.getProgramInfoLog(program));
    }
    return program;
  }

  const particleProgram = createProgram(gl, vsSource, fsSource);
  const aX = gl.getAttribLocation(particleProgram, "a_x");
  const aY = gl.getAttribLocation(particleProgram, "a_y");
  const aColor = gl.getAttribLocation(particleProgram, "a_color");
  const uResolution = gl.getUniformLocation(particleProgram, "u_resolution");
  const uPointSize = gl.getUniformLocation(particleProgram, "u_point_size");

  const bufX = gl.createBuffer()!;
  const bufY = gl.createBuffer()!;
  const bufColor = gl.createBuffer()!;

  // 2. Шейдер для окружностей (пилот / курсор)
  const circleVs = `
    attribute vec2 a_unit;
    uniform vec2 u_center;
    uniform float u_radius;
    uniform vec2 u_resolution;

    void main() {
      vec2 pos = u_center + a_unit * u_radius;
      vec2 zeroToOne = pos / u_resolution;
      vec2 clipSpace = zeroToOne * 2.0 - 1.0;
      gl_Position = vec4(clipSpace.x, -clipSpace.y, 0.0, 1.0);
    }
  `;

  const circleFs = `
    precision mediump float;
    uniform vec4 u_circle_color;
    void main() {
      gl_FragColor = u_circle_color;
    }
  `;

  const circleProgram = createProgram(gl, circleVs, circleFs);
  const aCircleUnit = gl.getAttribLocation(circleProgram, "a_unit");
  const uCircleCenter = gl.getUniformLocation(circleProgram, "u_center");
  const uCircleRadius = gl.getUniformLocation(circleProgram, "u_radius");
  const uCircleRes = gl.getUniformLocation(circleProgram, "u_resolution");
  const uCircleColor = gl.getUniformLocation(circleProgram, "u_circle_color");

  const CIRCLE_SEGMENTS = 32;
  const circleData = new Float32Array(CIRCLE_SEGMENTS * 2);
  for (let i = 0; i < CIRCLE_SEGMENTS; i++) {
    const angle = (i / CIRCLE_SEGMENTS) * Math.PI * 2;
    circleData[i * 2] = Math.cos(angle);
    circleData[i * 2 + 1] = Math.sin(angle);
  }
  const bufCircle = gl.createBuffer()!;
  gl.bindBuffer(gl.ARRAY_BUFFER, bufCircle);
  gl.bufferData(gl.ARRAY_BUFFER, circleData, gl.STATIC_DRAW);

  // Настройка вьюпорта
  gl.viewport(0, 0, W, H);
  gl.disable(gl.DEPTH_TEST);
  gl.disable(gl.BLEND);

  return {
    begin() {
      gl.viewport(0, 0, W, H);
      // Цвет фона #0b0f14: r=11/255, g=15/255, b=20/255
      gl.clearColor(11 / 255, 15 / 255, 20 / 255, 1.0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    },

    // Отрисовка пачки частиц прямо из колонок SoA памяти ECS
    drawParticleBatch(px: Float32Array, py: Float32Array, tintRgba: Uint32Array, count: number, pointSize = 1.5) {
      if (count <= 0) return;

      gl.useProgram(particleProgram);
      gl.uniform2f(uResolution, W, H);
      gl.uniform1f(uPointSize, pointSize);

      // Колонка X
      gl.bindBuffer(gl.ARRAY_BUFFER, bufX);
      gl.bufferData(gl.ARRAY_BUFFER, px.subarray(0, count), gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(aX);
      gl.vertexAttribPointer(aX, 1, gl.FLOAT, false, 0, 0);

      // Колонка Y
      gl.bindBuffer(gl.ARRAY_BUFFER, bufY);
      gl.bufferData(gl.ARRAY_BUFFER, py.subarray(0, count), gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(aY);
      gl.vertexAttribPointer(aY, 1, gl.FLOAT, false, 0, 0);

      // Колонка цвета RGBA (u32 трактуется как 4 unsigned bytes со сдвигом 0..1)
      gl.bindBuffer(gl.ARRAY_BUFFER, bufColor);
      gl.bufferData(gl.ARRAY_BUFFER, tintRgba.subarray(0, count), gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(aColor);
      gl.vertexAttribPointer(aColor, 4, gl.UNSIGNED_BYTE, true, 0, 0);

      gl.drawArrays(gl.POINTS, 0, count);
    },

    // Отрисовка кольца пилота или курсора
    drawCircle(x: number, y: number, radius: number, r: number, g: number, b: number, a = 1.0) {
      gl.useProgram(circleProgram);
      gl.uniform2f(uCircleRes, W, H);
      gl.uniform2f(uCircleCenter, x, y);
      gl.uniform1f(uCircleRadius, radius);
      gl.uniform4f(uCircleColor, r, g, b, a);

      gl.bindBuffer(gl.ARRAY_BUFFER, bufCircle);
      gl.enableVertexAttribArray(aCircleUnit);
      gl.vertexAttribPointer(aCircleUnit, 2, gl.FLOAT, false, 0, 0);

      gl.drawArrays(gl.LINE_LOOP, 0, CIRCLE_SEGMENTS);
    }
  };
}