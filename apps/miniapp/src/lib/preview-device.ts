import previewDevicePresets from './preview-device-presets.json';

export type PreviewDevice = keyof typeof previewDevicePresets;
export type PreviewDevicePreset = (typeof previewDevicePresets)[PreviewDevice];

const previewDeviceKeys = Object.keys(previewDevicePresets) as PreviewDevice[];

export function listPreviewDevices(): PreviewDevice[] {
  return previewDeviceKeys;
}

export function isPreviewDevice(value: string | null | undefined): value is PreviewDevice {
  return typeof value === 'string' && previewDeviceKeys.includes(value as PreviewDevice);
}

export function normalizePreviewDevice(value: string | null | undefined): PreviewDevice {
  return isPreviewDevice(value) ? value : 'android';
}

export function getPreviewDevicePreset(device: PreviewDevice): PreviewDevicePreset {
  return previewDevicePresets[device];
}
