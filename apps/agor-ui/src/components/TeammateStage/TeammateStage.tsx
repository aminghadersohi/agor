// biome-ignore-all lint/plugin/noHardcodedColorLiteral: bounded WebGL lighting and procedural-texture palette cannot consume AntD tokens at the Three.js boundary
import {
  PauseCircleOutlined,
  PlayCircleOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
} from '@ant-design/icons';
import { Avatar, Button, Flex, Grid, Result, Space, Tag, Typography, theme } from 'antd';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Material, Texture } from 'three';

interface TeammateStageProps {
  name: string;
  imageUrl?: string;
  emoji?: string;
  active?: boolean;
}

type StageStatus = 'loading' | 'ready' | 'fallback';

interface StageControls {
  reset: () => void;
  setAutoRotate: (enabled: boolean) => void;
}

function makeEmojiTexture(THREE: typeof import('three'), emoji: string) {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const context = canvas.getContext('2d');
  if (!context) return null;
  const gradient = context.createRadialGradient(196, 148, 24, 256, 256, 330);
  gradient.addColorStop(0, '#f6fbff');
  gradient.addColorStop(0.45, '#a9d8d3');
  gradient.addColorStop(1, '#183b43');
  context.fillStyle = gradient;
  context.fillRect(0, 0, 512, 512);
  context.font = '260px system-ui, sans-serif';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText(emoji || '🤖', 256, 278);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function opaqueCssColor(value: string): string {
  const rgba = value.match(/^rgba?\(\s*([^,]+),\s*([^,]+),\s*([^,)]+)/i);
  return rgba ? `rgb(${rgba[1]}, ${rgba[2]}, ${rgba[3]})` : value;
}

async function loadPortraitTexture(
  THREE: typeof import('three'),
  imageUrl: string | undefined,
  emoji: string
) {
  if (!imageUrl) return makeEmojiTexture(THREE, emoji);
  try {
    const texture = await new THREE.TextureLoader().loadAsync(imageUrl);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    return texture;
  } catch {
    return makeEmojiTexture(THREE, emoji);
  }
}

function TeammateStageFallback({ name, imageUrl, emoji }: TeammateStageProps) {
  const { token } = theme.useToken();
  return (
    <Flex
      vertical
      align="center"
      justify="center"
      gap={token.marginMD}
      style={{
        position: 'absolute',
        inset: 0,
        overflow: 'hidden',
        background: `radial-gradient(circle at 50% 28%, ${token.colorPrimaryBg}, ${token.colorBgContainer} 58%, ${token.colorBgBase})`,
      }}
    >
      <div
        style={{
          position: 'absolute',
          width: '46%',
          aspectRatio: '1',
          borderRadius: '50%',
          background: token.colorPrimaryBg,
          filter: 'blur(44px)',
          opacity: 0.72,
        }}
      />
      <Avatar
        alt={`${name} profile`}
        src={imageUrl}
        size={144}
        style={{
          fontSize: 74,
          border: `5px solid ${token.colorBorderSecondary}`,
          boxShadow: `0 20px 60px ${token.colorBgMask}`,
          zIndex: 1,
        }}
      >
        {emoji || '🤖'}
      </Avatar>
      <div
        style={{
          width: 220,
          height: 60,
          borderRadius: '50%',
          background: `linear-gradient(180deg, ${token.colorFillSecondary}, ${token.colorBgElevated})`,
          border: `1px solid ${token.colorBorderSecondary}`,
          boxShadow: `0 28px 50px ${token.colorBgMask}`,
          transform: 'perspective(400px) rotateX(62deg)',
          zIndex: 0,
        }}
      />
      <Typography.Title level={4} style={{ margin: 0, zIndex: 1 }}>
        {name}
      </Typography.Title>
      <Typography.Text type="secondary" style={{ zIndex: 1, textAlign: 'center' }}>
        Interactive 3D is unavailable in this browser. The private avatar still renders locally.
      </Typography.Text>
    </Flex>
  );
}

/**
 * Lazy, asset-free WebGL teammate presentation. The only image texture comes
 * from Agor's authenticated profile-image object URL; it is never uploaded to
 * a rendering or model-generation service.
 */
export function TeammateStage({ name, imageUrl, emoji = '🤖', active = true }: TeammateStageProps) {
  const { token } = theme.useToken();
  const screens = Grid.useBreakpoint();
  const compact = !screens.md;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const controlsRef = useRef<StageControls | undefined>(undefined);
  const [status, setStatus] = useState<StageStatus>('loading');
  const [autoRotate, setAutoRotate] = useState(true);
  const autoRotateRef = useRef(autoRotate);

  const resetCamera = useCallback(() => controlsRef.current?.reset(), []);
  const toggleAutoRotate = useCallback(() => {
    setAutoRotate((current) => {
      const next = !current;
      autoRotateRef.current = next;
      controlsRef.current?.setAutoRotate(next);
      return next;
    });
  }, []);

  useEffect(() => {
    if (!active) return;
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    let disposed = false;
    let frame = 0;
    let observer: ResizeObserver | undefined;
    let visibilityObserver: IntersectionObserver | undefined;
    let stageVisible = true;
    const cleanup: Array<() => void> = [];

    const initialize = async () => {
      const contextOptions = {
        alpha: true,
        antialias: true,
        powerPreference: 'high-performance',
      } as const;
      const context = (canvas.getContext('webgl2', contextOptions) ??
        canvas.getContext('webgl', contextOptions)) as WebGLRenderingContext | null;
      if (!context) {
        if (!disposed) setStatus('fallback');
        return;
      }

      const [THREE, { OrbitControls }] = await Promise.all([
        import('three'),
        import('three/examples/jsm/controls/OrbitControls.js'),
      ]);
      if (disposed) return;

      const renderer = new THREE.WebGLRenderer({
        canvas,
        context,
        alpha: true,
        antialias: true,
        powerPreference: 'high-performance',
      });
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.08;
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFShadowMap;
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

      const scene = new THREE.Scene();
      scene.background = new THREE.Color(token.colorBgBase);
      scene.fog = new THREE.FogExp2(token.colorBgBase, 0.055);

      const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 60);
      const homePosition = new THREE.Vector3(0, 2.35, 8.6);
      camera.position.copy(homePosition);

      const orbit = new OrbitControls(camera, canvas);
      orbit.target.set(0, 2.1, 0);
      orbit.enableDamping = true;
      orbit.dampingFactor = 0.06;
      orbit.enablePan = false;
      orbit.minDistance = 5.8;
      orbit.maxDistance = 11;
      orbit.minPolarAngle = Math.PI * 0.25;
      orbit.maxPolarAngle = Math.PI * 0.58;
      orbit.autoRotate =
        autoRotateRef.current && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      orbit.autoRotateSpeed = 0.55;
      controlsRef.current = {
        reset: () => {
          camera.position.copy(homePosition);
          orbit.target.set(0, 2.1, 0);
          orbit.update();
        },
        setAutoRotate: (enabled) => {
          orbit.autoRotate =
            enabled && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        },
      };

      const world = new THREE.Group();
      scene.add(world);

      const floor = new THREE.Mesh(
        new THREE.CircleGeometry(7.5, 96),
        new THREE.MeshStandardMaterial({
          color: new THREE.Color(token.colorBgContainer),
          roughness: 0.72,
          metalness: 0.12,
        })
      );
      floor.rotation.x = -Math.PI / 2;
      floor.position.y = -0.55;
      floor.receiveShadow = true;
      world.add(floor);

      const metal = new THREE.MeshPhysicalMaterial({
        color: new THREE.Color(opaqueCssColor(token.colorTextSecondary)),
        roughness: 0.2,
        metalness: 0.88,
        clearcoat: 0.75,
        clearcoatRoughness: 0.18,
      });
      const darkMetal = new THREE.MeshPhysicalMaterial({
        color: new THREE.Color(opaqueCssColor(token.colorBgElevated)),
        roughness: 0.28,
        metalness: 0.72,
        clearcoat: 0.55,
      });
      const accent = new THREE.MeshStandardMaterial({
        color: new THREE.Color(token.colorPrimary),
        emissive: new THREE.Color(token.colorPrimary),
        emissiveIntensity: 1.2,
        roughness: 0.3,
        metalness: 0.35,
      });

      const base = new THREE.Mesh(new THREE.CylinderGeometry(1.82, 2.08, 0.34, 96), darkMetal);
      base.position.y = -0.35;
      base.castShadow = true;
      base.receiveShadow = true;
      world.add(base);
      const plinth = new THREE.Mesh(new THREE.CylinderGeometry(1.56, 1.74, 0.55, 96), metal);
      plinth.position.y = 0.06;
      plinth.castShadow = true;
      plinth.receiveShadow = true;
      world.add(plinth);
      const lightRing = new THREE.Mesh(new THREE.TorusGeometry(1.64, 0.035, 16, 96), accent);
      lightRing.rotation.x = Math.PI / 2;
      lightRing.position.y = 0.31;
      world.add(lightRing);

      const portrait = new THREE.Group();
      portrait.position.y = 0.24;
      world.add(portrait);

      const sculpt = new THREE.MeshPhysicalMaterial({
        color: new THREE.Color(opaqueCssColor(token.colorTextTertiary)),
        roughness: 0.38,
        metalness: 0.5,
        clearcoat: 0.5,
        clearcoatRoughness: 0.24,
      });
      const shoulders = new THREE.Mesh(new THREE.SphereGeometry(1.25, 64, 40), sculpt);
      shoulders.scale.set(1.42, 0.75, 0.68);
      shoulders.position.y = 1.18;
      shoulders.castShadow = true;
      portrait.add(shoulders);
      const chestCut = new THREE.Mesh(new THREE.CylinderGeometry(1.16, 1.42, 0.66, 64), sculpt);
      chestCut.position.y = 0.72;
      chestCut.castShadow = true;
      portrait.add(chestCut);
      const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.36, 0.48, 0.62, 48), sculpt);
      neck.position.y = 1.96;
      neck.castShadow = true;
      portrait.add(neck);
      const head = new THREE.Mesh(new THREE.SphereGeometry(0.78, 64, 48), sculpt);
      head.scale.set(0.88, 1.08, 0.82);
      head.position.y = 2.72;
      head.castShadow = true;
      portrait.add(head);

      const portraitTexture = await loadPortraitTexture(THREE, imageUrl, emoji);
      if (disposed) {
        portraitTexture?.dispose();
        renderer.dispose();
        orbit.dispose();
        return;
      }
      const faceMaterial = new THREE.MeshPhysicalMaterial({
        map: portraitTexture,
        transparent: true,
        roughness: 0.5,
        clearcoat: 0.2,
        side: THREE.DoubleSide,
      });
      const face = new THREE.Mesh(new THREE.CircleGeometry(0.59, 96), faceMaterial);
      face.position.set(0, 2.73, 0.69);
      portrait.add(face);
      const portraitRing = new THREE.Mesh(new THREE.TorusGeometry(0.63, 0.025, 14, 96), accent);
      portraitRing.position.set(0, 2.73, 0.7);
      portrait.add(portraitRing);

      scene.add(new THREE.HemisphereLight(0xbfe8ff, 0x12151f, 1.4));
      const keyLight = new THREE.SpotLight(0xd9fbff, 92, 24, Math.PI / 7, 0.55, 1.35);
      keyLight.position.set(-4.8, 8.5, 5.6);
      keyLight.target.position.set(0, 1.7, 0);
      keyLight.castShadow = true;
      keyLight.shadow.mapSize.set(1024, 1024);
      scene.add(keyLight, keyLight.target);
      const rimLight = new THREE.SpotLight(0x8b7cff, 118, 20, Math.PI / 6, 0.62, 1.4);
      rimLight.position.set(5.5, 5.6, -4.2);
      rimLight.target.position.set(0, 2.2, 0);
      scene.add(rimLight, rimLight.target);
      const fillLight = new THREE.PointLight(0x55d8c8, 34, 12, 1.6);
      fillLight.position.set(-3.2, 1.4, 3.2);
      scene.add(fillLight);

      const particles = new Float32Array(90 * 3);
      for (let index = 0; index < 90; index += 1) {
        const angle = index * 2.399963;
        const radius = 2.7 + ((index * 37) % 100) / 32;
        particles[index * 3] = Math.cos(angle) * radius;
        particles[index * 3 + 1] = ((index * 53) % 100) / 14 - 0.5;
        particles[index * 3 + 2] = Math.sin(angle) * radius;
      }
      const particleGeometry = new THREE.BufferGeometry();
      particleGeometry.setAttribute('position', new THREE.BufferAttribute(particles, 3));
      const particleMaterial = new THREE.PointsMaterial({
        color: new THREE.Color(token.colorPrimary),
        size: 0.025,
        transparent: true,
        opacity: 0.48,
      });
      const particleField = new THREE.Points(particleGeometry, particleMaterial);
      scene.add(particleField);

      const resize = () => {
        const width = Math.max(container.clientWidth, 1);
        const height = Math.max(container.clientHeight, 1);
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
        renderer.setSize(width, height, false);
      };
      resize();
      observer = new ResizeObserver(resize);
      observer.observe(container);
      if ('IntersectionObserver' in window) {
        visibilityObserver = new IntersectionObserver(([entry]) => {
          stageVisible = entry?.isIntersecting ?? true;
        });
        visibilityObserver.observe(container);
      }

      const render = (timestamp: number) => {
        if (disposed) return;
        frame = requestAnimationFrame(render);
        if (!stageVisible || document.hidden) return;
        const elapsed = timestamp / 1_000;
        if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
          portrait.position.y = 0.24 + Math.sin(elapsed * 0.72) * 0.025;
          lightRing.rotation.z = elapsed * 0.055;
          particleField.rotation.y = elapsed * 0.018;
        }
        orbit.update();
        renderer.render(scene, camera);
      };
      frame = requestAnimationFrame(render);
      setStatus('ready');

      cleanup.push(() => {
        cancelAnimationFrame(frame);
        observer?.disconnect();
        visibilityObserver?.disconnect();
        controlsRef.current = undefined;
        orbit.dispose();
        scene.traverse((object) => {
          if (!(object instanceof THREE.Mesh) && !(object instanceof THREE.Points)) return;
          object.geometry.dispose();
          const materials = Array.isArray(object.material) ? object.material : [object.material];
          for (const material of materials) {
            const mappedMaterial = material as Material & { map?: Texture | null };
            mappedMaterial.map?.dispose();
            material.dispose();
          }
        });
        renderer.dispose();
      });
    };

    setStatus('loading');
    void initialize().catch(() => {
      if (!disposed) setStatus('fallback');
    });
    return () => {
      disposed = true;
      for (const dispose of cleanup) dispose();
    };
  }, [
    active,
    emoji,
    imageUrl,
    token.colorBgBase,
    token.colorBgContainer,
    token.colorBgElevated,
    token.colorPrimary,
    token.colorTextSecondary,
    token.colorTextTertiary,
  ]);

  return (
    <Flex vertical gap={token.marginSM} style={{ width: '100%', minWidth: 0 }}>
      <div
        ref={containerRef}
        data-testid="teammate-stage-surface"
        style={{
          position: 'relative',
          width: '100%',
          boxSizing: 'border-box',
          minHeight: compact ? 410 : 500,
          maxHeight: 620,
          aspectRatio: compact ? '4 / 5' : '16 / 10',
          overflow: 'hidden',
          borderRadius: token.borderRadiusLG,
          border: `1px solid ${token.colorBorderSecondary}`,
          background: token.colorBgBase,
        }}
      >
        <canvas
          ref={canvasRef}
          role="img"
          aria-label={`Interactive 3D stage preview for ${name}`}
          style={{
            display: status === 'fallback' ? 'none' : 'block',
            width: '100%',
            height: '100%',
          }}
        />
        {status === 'loading' && (
          <Flex align="center" justify="center" style={{ position: 'absolute', inset: 0 }}>
            <Result icon={<SafetyCertificateOutlined />} title="Preparing private 3D stage…" />
          </Flex>
        )}
        {status === 'fallback' && (
          <TeammateStageFallback name={name} imageUrl={imageUrl} emoji={emoji} />
        )}
        <Flex
          vertical
          gap={2}
          style={{
            position: 'absolute',
            insetInline: token.paddingLG,
            bottom: token.paddingLG,
            pointerEvents: 'none',
            textShadow: `0 2px 14px ${token.colorBgBase}`,
          }}
        >
          <Typography.Title level={compact ? 4 : 3} style={{ margin: 0 }}>
            {name}
          </Typography.Title>
          <Typography.Text type="secondary">Teammate stage prototype</Typography.Text>
        </Flex>
      </div>

      <Flex justify="space-between" align="center" gap={token.marginSM} wrap>
        <Space wrap>
          <Button
            icon={autoRotate ? <PauseCircleOutlined /> : <PlayCircleOutlined />}
            onClick={toggleAutoRotate}
            disabled={status !== 'ready'}
          >
            {autoRotate ? 'Pause rotation' : 'Resume rotation'}
          </Button>
          <Button icon={<ReloadOutlined />} onClick={resetCamera} disabled={status !== 'ready'}>
            Reset view
          </Button>
        </Space>
        <Tag icon={<SafetyCertificateOutlined />} color="success" style={{ marginInlineEnd: 0 }}>
          Local rendering
        </Tag>
      </Flex>
      <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
        Drag to orbit and scroll or pinch to zoom. The profile image stays inside this browser and
        is used only as the portrait texture.
      </Typography.Text>
    </Flex>
  );
}
