// biome-ignore-all lint/plugin/noHardcodedColorLiteral: canvas artwork uses a fixed phosphor palette outside Ant Design's DOM styling boundary
import { useCallback, useEffect, useRef, useState } from 'react';

export const DEFAULT_SCREENSAVER_IDLE_MS = 5 * 60 * 1000;

const ACTIVITY_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'touchstart', 'wheel'] as const;
const GLYPHS = 'AGOR<>/{}[]01:+*·◇△○⌁⌘';
const MAX_DEVICE_PIXEL_RATIO = 2;
const POINTER_MOVE_THROTTLE_MS = 750;
const START_SCREENSAVER_EVENT = 'agor:start-idle-screensaver';

export function startIdleGlyphScreensaver(): void {
  window.dispatchEvent(new Event(START_SCREENSAVER_EVENT));
}

interface SignalStream {
  x: number;
  y: number;
  speed: number;
  spacing: number;
  length: number;
  phase: number;
  rotation: number;
  rotationSpeed: number;
  scale: number;
}

export interface IdleGlyphScreensaverProps {
  idleMs?: number;
}

function createStreams(width: number, height: number): SignalStream[] {
  const count = Math.max(18, Math.ceil(width / 34));
  return Array.from({ length: count }, (_, index) => {
    const scale = 0.65 + Math.random() * 0.8;
    return {
      x: ((index + Math.random() * 0.8) / count) * width,
      y: Math.random() * height * -1.2,
      speed: (28 + Math.random() * 72) * scale,
      spacing: 17 + Math.random() * 11,
      length: 7 + Math.floor(Math.random() * 15),
      phase: Math.floor(Math.random() * GLYPHS.length),
      rotation: (Math.random() - 0.5) * 0.42,
      rotationSpeed: (Math.random() - 0.5) * 0.18,
      scale,
    };
  });
}

function drawFrame(
  context: CanvasRenderingContext2D,
  streams: SignalStream[],
  width: number,
  height: number,
  elapsedSeconds: number,
  deltaSeconds: number
) {
  const wash = context.createLinearGradient(0, 0, 0, height);
  wash.addColorStop(0, 'rgba(2, 10, 9, 0.20)');
  wash.addColorStop(0.55, 'rgba(0, 6, 5, 0.12)');
  wash.addColorStop(1, 'rgba(0, 2, 2, 0.28)');
  context.fillStyle = wash;
  context.fillRect(0, 0, width, height);

  context.lineWidth = 0.6;
  context.strokeStyle = 'rgba(74, 246, 190, 0.07)';
  context.beginPath();
  for (let y = 48; y < height; y += 96) {
    const drift = Math.sin(elapsedSeconds * 0.18 + y * 0.01) * 22;
    context.moveTo(0, y + drift);
    context.bezierCurveTo(width * 0.3, y - 24, width * 0.72, y + 34, width, y - drift);
  }
  context.stroke();

  for (const stream of streams) {
    stream.y += stream.speed * deltaSeconds;
    stream.rotation += stream.rotationSpeed * deltaSeconds;
    const tailHeight = stream.length * stream.spacing;
    if (stream.y - tailHeight > height) {
      stream.y = -Math.random() * height * 0.7;
      stream.x = Math.random() * width;
    }

    context.save();
    context.translate(stream.x, stream.y);
    context.rotate(stream.rotation);
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.font = `${Math.round(13 * stream.scale)}px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;

    for (let index = 0; index < stream.length; index += 1) {
      const progress = index / stream.length;
      const pulse = 0.72 + Math.sin(elapsedSeconds * 2.4 + stream.phase + index) * 0.16;
      const alpha = Math.max(0.04, (1 - progress) ** 1.65 * pulse);
      const glyphIndex =
        (stream.phase + index + Math.floor(elapsedSeconds * (1.5 + stream.scale))) % GLYPHS.length;
      const glyph = GLYPHS[glyphIndex];
      const y = -index * stream.spacing;

      if (index === 0) {
        context.shadowColor = 'rgba(156, 255, 220, 0.85)';
        context.shadowBlur = 13;
        context.fillStyle = 'rgba(215, 255, 239, 0.96)';
      } else {
        context.shadowBlur = index < 4 ? 7 : 0;
        context.shadowColor = 'rgba(42, 245, 176, 0.55)';
        context.fillStyle = `rgba(${index % 3 === 0 ? '37, 222, 182' : '63, 244, 153'}, ${alpha})`;
      }
      context.fillText(glyph, Math.sin(elapsedSeconds + index * 0.7) * 2.2, y);
    }
    context.restore();
  }
}

export function IdleGlyphScreensaver({
  idleMs = DEFAULT_SCREENSAVER_IDLE_MS,
}: IdleGlyphScreensaverProps) {
  const [active, setActive] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const activeRef = useRef(false);

  const dismiss = useCallback(() => {
    activeRef.current = false;
    setActive(false);
  }, []);

  useEffect(() => {
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lastPointerMove = 0;

    const arm = () => {
      if (timer) clearTimeout(timer);
      if (document.visibilityState === 'hidden' || reducedMotion.matches) return;
      timer = setTimeout(() => {
        activeRef.current = true;
        setActive(true);
      }, idleMs);
    };

    const onActivity = (event: Event) => {
      if (event.type === 'pointermove' && !activeRef.current) {
        const now = performance.now();
        if (now - lastPointerMove < POINTER_MOVE_THROTTLE_MS) return;
        lastPointerMove = now;
      }
      dismiss();
      arm();
    };

    const onVisibilityChange = () => {
      dismiss();
      arm();
    };

    const onMotionPreferenceChange = () => {
      dismiss();
      arm();
    };

    const onManualStart = () => {
      if (reducedMotion.matches || document.visibilityState === 'hidden') return;
      if (timer) clearTimeout(timer);
      activeRef.current = true;
      setActive(true);
    };

    for (const eventName of ACTIVITY_EVENTS) {
      window.addEventListener(eventName, onActivity, { passive: true, capture: true });
    }
    document.addEventListener('visibilitychange', onVisibilityChange);
    reducedMotion.addEventListener('change', onMotionPreferenceChange);
    window.addEventListener(START_SCREENSAVER_EVENT, onManualStart);
    arm();

    return () => {
      if (timer) clearTimeout(timer);
      for (const eventName of ACTIVITY_EVENTS) {
        window.removeEventListener(eventName, onActivity, { capture: true });
      }
      document.removeEventListener('visibilitychange', onVisibilityChange);
      reducedMotion.removeEventListener('change', onMotionPreferenceChange);
      window.removeEventListener(START_SCREENSAVER_EVENT, onManualStart);
    };
  }, [dismiss, idleMs]);

  useEffect(() => {
    if (!active) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext('2d');
    if (!context) return;

    let animationFrame = 0;
    let streams: SignalStream[] = [];
    let width = 0;
    let height = 0;
    let previousTime = performance.now();

    const resize = () => {
      const pixelRatio = Math.min(window.devicePixelRatio || 1, MAX_DEVICE_PIXEL_RATIO);
      width = window.innerWidth;
      height = window.innerHeight;
      canvas.width = Math.round(width * pixelRatio);
      canvas.height = Math.round(height * pixelRatio);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      context.fillStyle = '#010706';
      context.fillRect(0, 0, width, height);
      streams = createStreams(width, height);
    };

    const animate = (time: number) => {
      const deltaSeconds = Math.min((time - previousTime) / 1000, 0.05);
      previousTime = time;
      drawFrame(context, streams, width, height, time / 1000, deltaSeconds);
      animationFrame = requestAnimationFrame(animate);
    };

    resize();
    window.addEventListener('resize', resize);
    animationFrame = requestAnimationFrame(animate);
    return () => {
      cancelAnimationFrame(animationFrame);
      window.removeEventListener('resize', resize);
    };
  }, [active]);

  if (!active) return null;

  return (
    <div
      role="dialog"
      aria-label="Agor idle screensaver"
      aria-modal="true"
      onPointerDown={dismiss}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 10000,
        overflow: 'hidden',
        cursor: 'none',
        background: '#010706',
      }}
    >
      <canvas ref={canvasRef} style={{ display: 'block' }} />
      <div
        style={{
          position: 'absolute',
          insetInline: 0,
          bottom: 28,
          textAlign: 'center',
          color: 'rgba(185, 255, 224, 0.64)',
          font: '12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
          letterSpacing: '0.18em',
          textTransform: 'uppercase',
          textShadow: '0 0 12px rgba(56, 245, 173, 0.45)',
          pointerEvents: 'none',
        }}
      >
        Agor signal field · move or press any key to return
      </div>
    </div>
  );
}
