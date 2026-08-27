// biome-ignore-all lint/plugin/noHardcodedColorLiteral: WebGL lights require numeric colors at the Three.js boundary

import type { ProfileIdentityModel } from '@agor-live/client';
import {
  PauseCircleOutlined,
  PlayCircleOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import {
  Alert,
  App,
  Avatar,
  Button,
  Flex,
  Grid,
  Progress,
  Space,
  Spin,
  Tag,
  Typography,
  theme,
} from 'antd';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Material, Texture } from 'three';

interface TeammateStageProps {
  name: string;
  imageUrl?: string;
  modelUrl?: string;
  identityModel?: ProfileIdentityModel;
  emoji?: string;
  active?: boolean;
  generating?: boolean;
  generationError?: string;
  onGenerate?: () => Promise<void>;
}

type StageStatus = 'idle' | 'loading' | 'ready' | 'fallback';

interface StageControls {
  reset: () => void;
  setAutoRotate: (enabled: boolean) => void;
}

function EmptyIdentityStage({
  name,
  imageUrl,
  emoji,
  identityModel,
  generating,
  onGenerate,
}: TeammateStageProps) {
  const { token } = theme.useToken();
  const { modal } = App.useApp();
  const activeGeneration =
    generating ||
    (identityModel && ['submitting', 'pending', 'in_progress'].includes(identityModel.status));

  const confirmGeneration = () => {
    if (!onGenerate || !imageUrl) return;
    modal.confirm({
      title: 'Generate a real 3D identity model?',
      content:
        'Agor will send this selected profile photo to Meshy for image-to-3D generation. This uses your configured Meshy account and may consume provider credits. The completed GLB is copied back into private Agor storage.',
      okText: 'Send photo and generate',
      cancelText: 'Cancel',
      onOk: onGenerate,
    });
  };

  return (
    <Flex
      vertical
      align="center"
      justify="center"
      gap={token.marginMD}
      style={{
        position: 'absolute',
        inset: 0,
        padding: token.paddingXL,
        textAlign: 'center',
        background: `radial-gradient(circle at 50% 28%, ${token.colorPrimaryBg}, ${token.colorBgContainer} 58%, ${token.colorBgBase})`,
      }}
    >
      <Avatar
        alt={`${name} source profile`}
        src={imageUrl}
        size={180}
        shape="square"
        style={{
          fontSize: 82,
          border: `1px solid ${token.colorBorderSecondary}`,
          boxShadow: token.boxShadowSecondary,
        }}
      >
        {emoji || '🤖'}
      </Avatar>
      <Flex vertical gap={2} align="center">
        <Typography.Title level={3} style={{ margin: 0 }}>
          {name}
        </Typography.Title>
        <Typography.Text type="secondary">
          {activeGeneration
            ? 'Building a textured GLB from the selected photo'
            : identityModel?.status === 'failed' || identityModel?.status === 'canceled'
              ? identityModel.error_message || 'The last generation did not complete'
              : 'No generated 3D model yet'}
        </Typography.Text>
      </Flex>
      {activeGeneration && (
        <Progress
          percent={identityModel?.progress ?? 0}
          status="active"
          style={{ width: 'min(320px, 100%)' }}
        />
      )}
      <Button
        type="primary"
        icon={<ThunderboltOutlined />}
        loading={Boolean(activeGeneration)}
        disabled={!imageUrl || !onGenerate || Boolean(activeGeneration)}
        onClick={confirmGeneration}
      >
        {identityModel?.model_available ? 'Regenerate 3D model' : 'Generate 3D model'}
      </Button>
      <Typography.Text type="secondary" style={{ maxWidth: 470, fontSize: token.fontSizeSM }}>
        Nothing is uploaded until you confirm. Rendering happens locally after Agor stores the
        generated model.
      </Typography.Text>
    </Flex>
  );
}

/** Real GLB model viewer for generated user and teammate identities. */
export function TeammateStage({
  name,
  imageUrl,
  modelUrl,
  identityModel,
  emoji = '🤖',
  active = true,
  generating = false,
  generationError,
  onGenerate,
}: TeammateStageProps) {
  const { token } = theme.useToken();
  const screens = Grid.useBreakpoint();
  const compact = !screens.md;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const controlsRef = useRef<StageControls | undefined>(undefined);
  const [status, setStatus] = useState<StageStatus>(modelUrl ? 'loading' : 'idle');
  const [autoRotate, setAutoRotate] = useState(true);
  const autoRotateRef = useRef(true);

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
    if (!active || !modelUrl) {
      setStatus('idle');
      return;
    }
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    let disposed = false;
    let frame = 0;
    let resizeObserver: ResizeObserver | undefined;
    let visibilityObserver: IntersectionObserver | undefined;
    let visible = true;

    const initialize = async () => {
      const contextOptions = {
        alpha: true,
        antialias: true,
        powerPreference: 'high-performance',
      } as const;
      const context = (canvas.getContext('webgl2', contextOptions) ??
        canvas.getContext('webgl', contextOptions)) as WebGLRenderingContext | null;
      if (!context) {
        setStatus('fallback');
        return undefined;
      }
      const [THREE, { OrbitControls }, { GLTFLoader }] = await Promise.all([
        import('three'),
        import('three/examples/jsm/controls/OrbitControls.js'),
        import('three/examples/jsm/loaders/GLTFLoader.js'),
      ]);
      if (disposed) return undefined;

      const renderer = new THREE.WebGLRenderer({ canvas, context, alpha: true, antialias: true });
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.08;
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

      const scene = new THREE.Scene();
      scene.background = new THREE.Color(token.colorBgBase);
      scene.fog = new THREE.FogExp2(token.colorBgBase, 0.038);
      const camera = new THREE.PerspectiveCamera(32, 1, 0.05, 80);
      const homePosition = new THREE.Vector3(0, 2.45, 8.2);
      camera.position.copy(homePosition);

      const orbit = new OrbitControls(camera, canvas);
      orbit.target.set(0, 2, 0);
      orbit.enableDamping = true;
      orbit.dampingFactor = 0.06;
      orbit.enablePan = false;
      orbit.minDistance = 3.6;
      orbit.maxDistance = 13;
      orbit.autoRotate =
        autoRotateRef.current && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      orbit.autoRotateSpeed = 0.7;
      controlsRef.current = {
        reset: () => {
          camera.position.copy(homePosition);
          orbit.target.set(0, 2, 0);
          orbit.update();
        },
        setAutoRotate: (enabled) => {
          orbit.autoRotate =
            enabled && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        },
      };

      const floor = new THREE.Mesh(
        new THREE.CircleGeometry(7.2, 96),
        new THREE.MeshStandardMaterial({
          color: new THREE.Color(token.colorBgContainer),
          roughness: 0.76,
          metalness: 0.12,
        })
      );
      floor.rotation.x = -Math.PI / 2;
      floor.receiveShadow = true;
      scene.add(floor);
      const podium = new THREE.Mesh(
        new THREE.CylinderGeometry(1.7, 1.92, 0.28, 96),
        new THREE.MeshPhysicalMaterial({
          color: new THREE.Color(token.colorBgElevated),
          roughness: 0.24,
          metalness: 0.72,
          clearcoat: 0.6,
        })
      );
      podium.position.y = 0.14;
      podium.receiveShadow = true;
      podium.castShadow = true;
      scene.add(podium);

      const gltf = await new GLTFLoader().loadAsync(modelUrl);
      if (disposed) return undefined;
      const model = gltf.scene;
      model.traverse((object) => {
        if (!(object instanceof THREE.Mesh)) return;
        object.castShadow = true;
        object.receiveShadow = true;
      });
      const sourceBounds = new THREE.Box3().setFromObject(model);
      const sourceSize = sourceBounds.getSize(new THREE.Vector3());
      if (!Number.isFinite(sourceSize.y) || sourceSize.y <= 0) {
        throw new Error('Generated model has no renderable bounds');
      }
      const scale = 4 / Math.max(sourceSize.y, sourceSize.x, sourceSize.z);
      model.scale.setScalar(scale);
      const bounds = new THREE.Box3().setFromObject(model);
      const center = bounds.getCenter(new THREE.Vector3());
      model.position.x -= center.x;
      model.position.z -= center.z;
      model.position.y += 0.3 - bounds.min.y;
      scene.add(model);

      scene.add(new THREE.HemisphereLight(0xccefff, 0x111522, 1.3));
      const key = new THREE.SpotLight(0xe5fbff, 105, 25, Math.PI / 6, 0.48, 1.25);
      key.position.set(-4.8, 8.5, 5.5);
      key.target.position.set(0, 2, 0);
      key.castShadow = true;
      scene.add(key, key.target);
      const rim = new THREE.SpotLight(0x8b7cff, 120, 22, Math.PI / 5, 0.58, 1.4);
      rim.position.set(5.2, 5.8, -4.2);
      rim.target.position.set(0, 2, 0);
      scene.add(rim, rim.target);
      const fill = new THREE.PointLight(0x55d8c8, 32, 14, 1.5);
      fill.position.set(-3, 2, 3.5);
      scene.add(fill);

      const resize = () => {
        const width = Math.max(1, container.clientWidth);
        const height = Math.max(1, container.clientHeight);
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
        renderer.setSize(width, height, false);
      };
      resize();
      resizeObserver = new ResizeObserver(resize);
      resizeObserver.observe(container);
      if ('IntersectionObserver' in window) {
        visibilityObserver = new IntersectionObserver(([entry]) => {
          visible = entry?.isIntersecting ?? true;
        });
        visibilityObserver.observe(container);
      }

      const render = () => {
        if (disposed) return;
        frame = requestAnimationFrame(render);
        if (!visible || document.hidden) return;
        orbit.update();
        renderer.render(scene, camera);
      };
      frame = requestAnimationFrame(render);
      setStatus('ready');

      return () => {
        cancelAnimationFrame(frame);
        resizeObserver?.disconnect();
        visibilityObserver?.disconnect();
        controlsRef.current = undefined;
        orbit.dispose();
        scene.traverse((object) => {
          if (!(object instanceof THREE.Mesh)) return;
          object.geometry.dispose();
          const materials = Array.isArray(object.material) ? object.material : [object.material];
          for (const material of materials) {
            const maps = material as Material & Record<string, Texture | unknown>;
            for (const key of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap']) {
              const texture = maps[key];
              if (texture && typeof (texture as Texture).dispose === 'function') {
                (texture as Texture).dispose();
              }
            }
            material.dispose();
          }
        });
        renderer.dispose();
      };
    };

    setStatus('loading');
    let cleanup: (() => void) | undefined;
    void initialize()
      .then((dispose) => {
        cleanup = dispose;
      })
      .catch(() => {
        if (!disposed) setStatus('fallback');
      });
    return () => {
      disposed = true;
      cleanup?.();
    };
  }, [active, modelUrl, token.colorBgBase, token.colorBgContainer, token.colorBgElevated]);

  return (
    <Flex vertical gap={token.marginSM} style={{ width: '100%', minWidth: 0 }}>
      {generationError && <Alert type="error" showIcon title={generationError} />}
      <div
        ref={containerRef}
        data-testid="teammate-stage-surface"
        style={{
          position: 'relative',
          boxSizing: 'border-box',
          width: '100%',
          minHeight: compact ? 430 : 520,
          maxHeight: 650,
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
          aria-label={`Interactive generated 3D model for ${name}`}
          style={{
            display: modelUrl && status !== 'fallback' ? 'block' : 'none',
            width: '100%',
            height: '100%',
          }}
        />
        {modelUrl && status === 'loading' && (
          <Flex align="center" justify="center" style={{ position: 'absolute', inset: 0 }}>
            <Spin size="large" description="Loading generated model…" />
          </Flex>
        )}
        {(!modelUrl || status === 'fallback') && (
          <EmptyIdentityStage
            name={name}
            imageUrl={imageUrl}
            emoji={emoji}
            identityModel={identityModel}
            generating={generating}
            onGenerate={onGenerate}
          />
        )}
        {modelUrl && status === 'ready' && (
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
            <Typography.Text type="secondary">Generated 3D identity</Typography.Text>
          </Flex>
        )}
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
          Private Agor model
        </Tag>
      </Flex>
      <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
        Drag to orbit and scroll or pinch to zoom. Agor renders the stored GLB locally in your
        browser.
      </Typography.Text>
    </Flex>
  );
}
