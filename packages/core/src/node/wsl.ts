import { readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

/**
 * What the WSL checks read; replaced in tests with fake tables. Every field is optional: a file
 * that cannot be read counts as absent.
 */
export interface WslProbe {
  /** `/proc/sys/kernel/osrelease`. */
  osrelease?: string | undefined;
  /** `/proc/self/mountinfo`. */
  mountinfo?: string | undefined;
  /** `/etc/wsl.conf`. */
  wslConf?: string | undefined;
  /** Canonical path; default `realpathSync.native`, falling back to the path as given. */
  realpath?: (path: string) => string;
}

/** The probe of the machine this runs on (Linux only; elsewhere every field is absent). */
export function hostWslProbe(): WslProbe {
  if (process.platform !== 'linux') return {};
  const read = (p: string) => {
    try {
      return readFileSync(p, 'utf8');
    } catch {
      return undefined;
    }
  };
  return {
    osrelease: read('/proc/sys/kernel/osrelease'),
    mountinfo: read('/proc/self/mountinfo'),
    wslConf: read('/etc/wsl.conf'),
  };
}

/**
 * Running inside WSL: the kernel release names Microsoft or WSL. A Microsoft WSL team member
 * called "WSL" in `/proc/sys/kernel/osrelease` the check that works everywhere
 * (github.com/microsoft/WSL/issues/423, read 2026-11-10). Containers inside WSL share the
 * kernel, so they read as WSL too, which only makes the warning more cautious.
 */
export function isWsl(probe: WslProbe): boolean {
  return /microsoft|wsl/i.test(probe.osrelease ?? '');
}

interface Mount {
  point: string;
  fstype: string;
  source: string;
  options: string;
}

/** `/proc/self/mountinfo` lines: mount point is field 5; after ` - `, fs type, source, options. */
function parseMountinfo(text: string): Mount[] {
  const out: Mount[] = [];
  for (const line of text.split('\n')) {
    const dash = line.indexOf(' - ');
    if (dash < 0) continue;
    const pre = line.slice(0, dash).split(' ');
    const post = line.slice(dash + 3).split(' ');
    const point = pre[4];
    if (point === undefined) continue;
    out.push({
      point: unescapeMount(point),
      fstype: post[0] ?? '',
      source: unescapeMount(post[1] ?? ''),
      options: [pre[5] ?? '', post[2] ?? ''].join(','),
    });
  }
  return out;
}

/** The kernel writes space, tab, newline and backslash in mount fields as octal escapes. */
function unescapeMount(s: string): string {
  return s.replace(/\\([0-7]{3})/g, (_, o: string) => String.fromCharCode(Number.parseInt(o, 8)));
}

/**
 * Where WSL mounts Windows drives: `[automount] root` in `/etc/wsl.conf`, default `/mnt/`
 * (learn.microsoft.com/windows/wsl/wsl-config, read from the MicrosoftDocs/WSL source,
 * 2026-11-10).
 */
function automountRoot(wslConf: string | undefined): string {
  let section = '';
  for (const raw of (wslConf ?? '').split('\n')) {
    const line = raw.replace(/[#;].*$/, '').trim();
    const head = /^\[(.+)\]$/.exec(line);
    if (head) {
      section = (head[1] ?? '').trim().toLowerCase();
      continue;
    }
    const kv = /^root\s*=\s*(.+)$/i.exec(line);
    if (section === 'automount' && kv) {
      const v = (kv[1] ?? '').trim().replace(/^["']|["']$/g, '');
      if (v.startsWith('/')) return v.endsWith('/') ? v : `${v}/`;
    }
  }
  return '/mnt/';
}

/**
 * The Windows drive `path` lives on inside WSL, or undefined (not WSL, or the distro's own
 * filesystem). Found by the longest mount point that contains the canonical path: a DrvFs mount
 * (by type, or `drvfs` in its options, or a drive-letter source such as `C:\`), or a drive
 * letter directly under the automount root. Microsoft's docs do not say how Windows drives show
 * in the mount table under WSL2, so every one of those signs counts (UNVERIFIED which one a
 * given WSL release shows); without a mount table, the automount root alone decides.
 */
export function windowsDrive(path: string, probe: WslProbe): string | undefined {
  if (!isWsl(probe)) return undefined;
  const real = canonical(resolve(path), probe.realpath ?? ((p: string) => realpathSync.native(p)));
  const root = automountRoot(probe.wslConf);
  const letterUnder = (p: string) => {
    if (!p.startsWith(root)) return undefined;
    const m = /^([a-z])(\/|$)/i.exec(p.slice(root.length));
    return m ? `${(m[1] as string).toUpperCase()}:` : undefined;
  };
  const mounts = probe.mountinfo ? parseMountinfo(probe.mountinfo) : [];
  // The longest mount point holding the path; of two at the same point, the later one is the
  // one in effect.
  const within = mounts
    .map((m, i) => ({ m, i }))
    .filter(({ m }) => real === m.point || real.startsWith(m.point === '/' ? '/' : `${m.point}/`))
    .sort((a, b) => b.m.point.length - a.m.point.length || b.i - a.i)[0]?.m;
  if (within) {
    const drive = /^([A-Za-z]):[\\/]?/.exec(within.source);
    const drvfs = within.fstype === 'drvfs' || /drvfs/i.test(within.options);
    if (drive) return `${(drive[1] as string).toUpperCase()}:`;
    if (drvfs) return letterUnder(within.point) ?? 'a Windows drive';
    if (within.fstype === '9p' || within.fstype === 'virtiofs') {
      return letterUnder(within.point);
    }
    return undefined;
  }
  return letterUnder(real);
}

/**
 * `path` with its longest existing ancestor made canonical: a state directory not created yet,
 * behind a symlink to a Windows drive, still resolves to the drive.
 */
function canonical(path: string, real: (p: string) => string): string {
  let head = path;
  const tail: string[] = [];
  for (;;) {
    try {
      return join(real(head), ...tail.reverse());
    } catch {
      const up = dirname(head);
      if (up === head) return path;
      tail.push(basename(head));
      head = up;
    }
  }
}

/**
 * Warnings for the paths Tacet works in, when any is on a Windows drive inside WSL: advisory,
 * never a refusal. Microsoft's advice is to keep files in the Linux file system when working from
 * a Linux command line: cross-OS access is much slower under WSL2, and DrvFs differs in
 * permissions (no metadata by default), case sensitivity and symlinks
 * (learn.microsoft.com/windows/wsl/filesystems and file-permissions, read from the
 * MicrosoftDocs/WSL source, 2026-11-10).
 */
export function wslPathWarnings(
  paths: readonly { label: string; path: string }[],
  probe: WslProbe = hostWslProbe(),
): string[] {
  const out: string[] = [];
  for (const { label, path } of paths) {
    const drive = windowsDrive(path, probe);
    if (drive === undefined) continue;
    out.push(
      `warning: the ${label} is on ${drive} (a Windows drive) inside WSL. Work there is much slower under WSL2, and file permissions, case sensitivity and symlinks differ from Linux, which Workers and their sandboxes rely on. Fix: keep it in the distro's own file system, e.g. clone the repo under ~/ (docs/WSL2.md).`,
    );
  }
  return out;
}
