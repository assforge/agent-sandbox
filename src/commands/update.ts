import { CliError, packageVersion, SELF_PACKAGE, type MainDeps } from './deps.js';

export async function updateCommand(deps: MainDeps, check: boolean): Promise<number> {
  const current = packageVersion();
  const probed = deps.runner.run('npm', ['view', SELF_PACKAGE, 'version']);
  if (probed.status !== 0) throw new CliError(`cannot check the latest ${SELF_PACKAGE} version`, 1);
  const latest = probed.stdout.trim();
  if (!latest) throw new CliError(`cannot check the latest ${SELF_PACKAGE} version`, 1);
  if (check) {
    deps.stdout(`current ${current}, latest ${latest}\n`);
    return 0;
  }
  if (latest === current) {
    deps.stdout(`sandbox ${current} is already current\n`);
    return 0;
  }
  const installed = deps.runner.run('npm', ['install', '-g', `${SELF_PACKAGE}@${latest}`]);
  if (installed.status !== 0) {
    const detail = installed.stderr.trim() || installed.stdout.trim();
    throw new CliError(`update to ${latest} failed${detail ? `: ${detail}` : ''}; check npm authentication for the package registry`, 1);
  }
  deps.stdout(`updated sandbox ${current} -> ${latest}; run sandbox workspace upgrade to rebuild images with the new CLI\n`);
  return 0;
}
