import fs from 'node:fs';
import path from 'node:path';
import type { MakerBase } from '@electron-forge/maker-base';
import { describe, expect, test } from 'vitest';
import forgeConfig from '../../forge.config';

const assetsDirectory = path.resolve(__dirname, '../../assets');

const getMakerConfig = async (name: string): Promise<unknown> => {
  const makers = forgeConfig.makers as MakerBase<unknown>[] | undefined;
  const maker = makers?.find((candidate) => candidate.name === name);

  if (!maker) return undefined;

  await maker.prepareConfig('x64');
  return maker.config;
};

describe('desktop icon packaging', () => {
  test('supplies native icon files to every declared package target', async () => {
    expect(forgeConfig.packagerConfig.icon).toBe('assets/icon');
    expect(forgeConfig.packagerConfig.extraResource).toContain(
      'assets/icon.png',
    );
    await expect(getMakerConfig('squirrel')).resolves.toMatchObject({
      setupIcon: 'assets/icon.ico',
    });
    await expect(getMakerConfig('deb')).resolves.toMatchObject({
      options: { icon: 'assets/icon.png' },
    });
    await expect(getMakerConfig('rpm')).resolves.toMatchObject({
      options: { icon: 'assets/icon.png' },
    });

    const ico = fs.readFileSync(path.join(assetsDirectory, 'icon.ico'));
    expect(ico.subarray(0, 4)).toEqual(Buffer.from([0, 0, 1, 0]));
    expect(ico.readUInt16LE(4)).toBeGreaterThan(1);

    const icns = fs.readFileSync(path.join(assetsDirectory, 'icon.icns'));
    expect(icns.subarray(0, 4).toString('ascii')).toBe('icns');
    expect(icns.readUInt32BE(4)).toBe(icns.length);
  });
});
