export function hostingConfig({ provider, name, origin, sshTarget }, previous = {}) {
  if (!['render', 'vm'].includes(provider)) throw new Error('Provider must be render or vm. Fly uses npm run deploy:fly.');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(name ?? '')) throw new Error('Provide --name with the deployment name.');
  const same = previous.provider === provider && previous.name === name;
  let publicOrigin = origin || (same ? previous.publicOrigin : undefined);
  if (publicOrigin) {
    let url;
    try { url = new URL(publicOrigin); } catch { throw new Error('Provide a valid HTTPS origin.'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/' || url.port) throw new Error('Provide an HTTPS origin without credentials, path, query, or port.');
    if (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Hosted origin must be publicly reachable.');
    publicOrigin = url.origin;
  }
  const target = sshTarget || (same ? previous.sshTarget : undefined);
  if (target && !/^(?:[a-zA-Z0-9_][a-zA-Z0-9_.-]*@)?[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(target)) throw new Error('Provide an SSH host/alias, optionally prefixed with user@. Configure keys in your SSH config.');
  if (provider === 'vm' && !publicOrigin) throw new Error('VM deployments need --origin from the agent-configured DNS name.');
  return { provider, name, publicOrigin, sshTarget: target, ...(same && previous.adminToken ? { adminToken: previous.adminToken } : {}) };
}

export function connectionCommand(config) {
  if (config.provider === 'fly' || (!config.provider && config.app)) {
    if (!/^[a-z][a-z0-9-]{2,62}$/.test(config.app ?? '')) throw new Error('Invalid Fly app name.');
    return { command: 'fly', args: ['proxy', '4175:4173', '--bind-addr', '127.0.0.1', '--app', config.app] };
  }
  const valid = hostingConfig({ ...config, origin: config.publicOrigin }, config);
  if (!valid.sshTarget) throw new Error('Record the provider SSH destination with npm run hosted:prepare -- --ssh <destination>.');
  return { command: 'ssh', args: ['-N', '-o', 'ExitOnForwardFailure=yes', '-L', '127.0.0.1:4175:127.0.0.1:4173', valid.sshTarget] };
}
