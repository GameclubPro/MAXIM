export const command = [
  'node',
  'apps/api/dist/apps/api/src/moderation/photo-duplicate/native-photo-sandbox.entrypoint.js',
];
export const environment = {
  NODE_ENV: 'production',
  PHOTO_NATIVE_SANDBOX_SOCKET_PATH: '/run/maxim-photo/native-photo.sock',
  PHOTO_DUPLICATE_MAX_BYTES: '16777216',
  PHOTO_DUPLICATE_MAX_PIXELS: '40000000',
  VIPS_CONCURRENCY: '1',
};
export const image = `sha256:${'a'.repeat(64)}`;
export function config() {
  return {
    services: {
      'photo-native-sandbox': {
        labels: { 'com.maxim.photo-native-sandbox': 'true' },
        network_mode: 'none',
        user: '1000:1000',
        init: true,
        read_only: true,
        cpus: 1,
        mem_limit: '1073741824',
        pids_limit: 64,
        deploy: { replicas: 1 },
        restart: 'unless-stopped',
        cap_drop: ['ALL'],
        security_opt: ['no-new-privileges:true'],
        tmpfs: ['/tmp:size=64m,mode=1777,uid=1000,gid=1000'],
        command,
        healthcheck: {
          test: ['CMD', ...command, '--probe'],
          timeout: '8s',
          interval: '10s',
          retries: 3,
          start_period: '20s',
        },
        environment: { ...environment },
        volumes: [{ type: 'volume', source: 'photo_native_ipc', target: '/run/maxim-photo' }],
      },
      'api-moderation-background': {
        environment: {
          PHOTO_NATIVE_SANDBOX_SOCKET_PATH: environment.PHOTO_NATIVE_SANDBOX_SOCKET_PATH,
        },
        depends_on: { 'photo-native-sandbox': { condition: 'service_healthy' } },
        volumes: [
          {
            type: 'volume',
            source: 'photo_native_ipc',
            target: '/run/maxim-photo',
            read_only: true,
          },
        ],
      },
    },
  };
}
export function runtime(project = 'infra') {
  return {
    Name: `/${project}-photo-native-sandbox-1`,
    Image: image,
    State: { Running: true, Status: 'running', Health: { Status: 'healthy' } },
    Config: {
      User: '1000:1000',
      Cmd: command,
      Entrypoint: ['docker-entrypoint.sh'],
      Env: [
        ...Object.entries(environment).map(([key, value]) => `${key}=${value}`),
        'NODE_VERSION=24.16.0',
        'YARN_VERSION=1.22.22',
        'HOME=/home/node',
        'NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/russian-trusted-ca-bundle.crt',
      ],
      Labels: {
        'com.docker.compose.project': project,
        'com.docker.compose.service': 'photo-native-sandbox',
        'com.maxim.photo-native-sandbox': 'true',
        'com.maxim.photo-native-sandbox-capable': 'true',
        ...(project === 'infra' ? { 'com.maxim.release-protected': 'true' } : {}),
      },
      Healthcheck: {
        Test: ['CMD', ...command, '--probe'],
        Interval: 10e9,
        Timeout: 8e9,
        StartPeriod: 20e9,
        Retries: 3,
      },
    },
    HostConfig: {
      NetworkMode: 'none',
      ReadonlyRootfs: true,
      Privileged: false,
      Init: true,
      RestartPolicy: { Name: 'unless-stopped' },
      PidsLimit: 64,
      Memory: 1073741824,
      NanoCpus: 1e9,
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges:true'],
      Tmpfs: { '/tmp': 'size=64m,mode=1777,uid=1000,gid=1000' },
      IpcMode: 'private',
    },
    Mounts: [
      {
        Type: 'volume',
        Name: `${project}_photo_native_ipc`,
        Destination: '/run/maxim-photo',
        RW: true,
      },
    ],
    NetworkSettings: { Networks: { none: {} } },
  };
}
