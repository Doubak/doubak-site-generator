/** 三个 CLI 共用参数解析。带值的选项不能吞掉后面的路径或布尔选项。 */

const VALUE_OPTIONS = new Map([
  ['--site-title', 'siteTitle'], ['--source-repo', 'sourceRepo'], ['--drop-notes', 'dropNotes'],
]);

/** @param {string[]} args */
export function parseCliArgs(args) {
  const result = { positionals: [], flags: new Set(), siteTitle: null, sourceRepo: null, dropNotes: null };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') {
      result.positionals.push(...args.slice(i + 1));
      break;
    }
    const equals = arg.indexOf('=');
    const name = equals < 0 ? arg : arg.slice(0, equals);
    const key = VALUE_OPTIONS.get(name);
    if (key) {
      const value = equals < 0 ? args[++i] : arg.slice(equals + 1);
      if (!value?.trim() || (equals < 0 && value.startsWith('--'))) {
        throw new Error(`${name} 需要一个非空值（也可写成 ${name}=<值>）。`);
      }
      result[key] = value;
    } else if (arg.startsWith('--')) {
      result.flags.add(arg);
    } else {
      result.positionals.push(arg);
    }
  }
  return result;
}
