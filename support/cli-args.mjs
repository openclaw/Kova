export function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) {
      throw new Error(`unexpected positional argument '${value}'`);
    }
    const key = value.slice(2);
    const next = values[index + 1];
    if (!next || next.startsWith("--")) {
      throw new Error(`missing value for --${key}`);
    }
    parsed[key] = next;
    index += 1;
  }
  return parsed;
}

export function requiredArg(values, key) {
  const value = values[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`missing --${key}`);
  }
  return value;
}

export function positiveInt(value, key) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`--${key} must be a positive integer`);
  }
  return number;
}

export function assertKovaEnvName(value) {
  if (!/^kova-[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
    throw new Error(`unsafe Kova env name '${value}'`);
  }
}

export function requiredSupportArg(values, key) {
  const value = values[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`--${key} is required`);
  }
  return value;
}

export function parseAllowedArgs(argv, allowedKeys) {
  const args = {};
  const allowed = new Set(allowedKeys);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      throw new Error(`unexpected positional argument: ${arg}`);
    }
    const key = arg.slice(2);
    if (!allowed.has(key)) {
      throw new Error(`unexpected argument: ${arg}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${arg} requires a value`);
    }
    args[key] = value;
    index += 1;
  }
  return args;
}

export function parseCompactArgs(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) {
      throw new Error(`unexpected argument: ${arg}`);
    }
    const key = arg.slice(2).replaceAll("-", "");
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${arg} requires a value`);
    }
    parsed[key] = value;
    index += 1;
  }
  return parsed;
}

export function parseControlFileArgs(args, requiredKeys) {
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag?.startsWith("--") || value === undefined) {
      throw new Error(`invalid argument: ${flag ?? ""}`);
    }
    values[flag.slice(2)] = value;
  }
  for (const key of requiredKeys) {
    if (!values[key]) {
      throw new Error(`--${key} is required`);
    }
  }
  return values;
}
