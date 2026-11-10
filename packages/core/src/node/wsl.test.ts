import { describe, expect, it } from 'vitest';
import { isWsl, type WslProbe, windowsDrive, wslPathWarnings } from './wsl.js';

const WSL2 = '5.15.167.4-microsoft-standard-WSL2';
/** A WSL2-shaped mount table: the distro on ext4, C: and D: from Windows (fake, #193). */
const MOUNTS = [
  '29 1 8:48 / / rw,relatime - ext4 /dev/sdc rw,discard,errors=remount-ro',
  '90 29 0:52 / /mnt/c rw,noatime - 9p C:\\134 rw,aname=drvfs;path=C:;uid=1000;gid=1000',
  '91 29 0:53 / /mnt/d rw,noatime - drvfs D:\\134 rw,metadata,case=off',
  '92 29 0:54 / /mnt/wsl rw,relatime - tmpfs none rw',
  '93 29 0:55 / /mnt/my\\040share rw - 9p E:\\134 rw,aname=drvfs',
].join('\n');
const probe = (more: Partial<WslProbe> = {}): WslProbe => ({
  osrelease: WSL2,
  mountinfo: MOUNTS,
  realpath: (p) => p,
  ...more,
});

describe('WSL checks (#193)', () => {
  it('knows WSL by the kernel release', () => {
    expect(isWsl({ osrelease: WSL2 })).toBe(true);
    expect(isWsl({ osrelease: '4.4.0-19041-Microsoft' })).toBe(true);
    expect(isWsl({ osrelease: '6.8.0-45-generic' })).toBe(false);
    expect(isWsl({})).toBe(false);
  });

  it('finds a repo on a Windows drive, by mount type, options or source', () => {
    expect(windowsDrive('/mnt/c/Users/me/repo', probe())).toBe('C:');
    expect(windowsDrive('/mnt/d/src/repo', probe())).toBe('D:');
    expect(windowsDrive('/mnt/my share/repo', probe())).toBe('E:');
    expect(windowsDrive('/mnt/c', probe())).toBe('C:');
  });

  it("leaves the distro's own file system alone, and everything outside WSL", () => {
    expect(windowsDrive('/home/me/repo', probe())).toBeUndefined();
    expect(windowsDrive('/mnt/wsl/x', probe())).toBeUndefined();
    expect(windowsDrive('/mnt/c/repo', probe({ osrelease: '6.8.0-generic' }))).toBeUndefined();
  });

  it('resolves symlinks first: a link in ~ to /mnt/c is still on C:', () => {
    const p = probe({ realpath: (x) => (x === '/home/me/repo' ? '/mnt/c/repo' : x) });
    expect(windowsDrive('/home/me/repo', p)).toBe('C:');
  });

  it('honours [automount] root, and falls back to it without a mount table', () => {
    const conf = '# custom\n[automount]\nenabled = true\nroot = /windir/\n';
    expect(windowsDrive('/windir/c/repo', probe({ mountinfo: undefined, wslConf: conf }))).toBe(
      'C:',
    );
    expect(
      windowsDrive('/mnt/c/repo', probe({ mountinfo: undefined, wslConf: conf })),
    ).toBeUndefined();
    expect(windowsDrive('/mnt/c/repo', probe({ mountinfo: undefined }))).toBe('C:');
    expect(windowsDrive('/mnt/cache/repo', probe({ mountinfo: undefined }))).toBeUndefined();
  });

  it('warns with the reason and the fix, for each path on a Windows drive', () => {
    const w = wslPathWarnings(
      [
        { label: 'repo', path: '/mnt/c/repo' },
        { label: 'state directory', path: '/home/me/.tacet/state' },
      ],
      probe(),
    );
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/repo is on C: .*inside WSL/);
    expect(w[0]).toMatch(/slower/);
    expect(w[0]).toMatch(/clone the repo under ~\//);
    expect(wslPathWarnings([{ label: 'repo', path: '/home/me/repo' }], probe())).toEqual([]);
  });
});
