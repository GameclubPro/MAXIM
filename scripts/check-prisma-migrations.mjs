import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const migrationNamePattern = /^\d{14}_[a-z0-9]+(?:_[a-z0-9]+)*$/u;
const identifierStartPattern = /[A-Za-z_\u0080-\uFFFF]/u;
const identifierPartPattern = /[A-Za-z0-9_$\u0080-\uFFFF]/u;
const nonColumnAlterDropWords = new Set([
  'CONSTRAINT',
  'DEFAULT',
  'EXPRESSION',
  'IDENTITY',
  'INHERIT',
  'NOT',
  'OF',
  'OIDS',
  'STATISTICS',
]);
export const IMMUTABLE_PRISMA_POLICY_PREFIX = Object.freeze({
  rulesAfter: '20260718183000_add_vk_rich_text_channel_link',
  namesSha256: '43053fd9b942aadd60cd69472f3025fa29943613f0478fd3487830e3e751a28b',
  contentsSha256: 'e22881cda75a72a56c223ad61132e46c2b5b8b593758ad655549cf75b89c88c4',
});

function isIdentifierStart(char) {
  return Boolean(char && identifierStartPattern.test(char));
}

function isIdentifierPart(char) {
  return Boolean(char && identifierPartPattern.test(char));
}

function readEscapeSequence(sql, index, mode) {
  const simpleEscapes = new Map([
    ['b', '\b'],
    ['f', '\f'],
    ['n', '\n'],
    ['r', '\r'],
    ['t', '\t'],
  ]);
  const next = sql[index + 1];
  if (mode === 'unicode') {
    if (next === '\\') {
      return { end: index + 2, value: '\\', uncertain: false };
    }
    const plusForm = next === '+';
    const digitsStart = index + (plusForm ? 2 : 1);
    const digitsLength = plusForm ? 6 : 4;
    const digits = sql.slice(digitsStart, digitsStart + digitsLength);
    if (new RegExp(`^[0-9a-f]{${digitsLength}}$`, 'iu').test(digits)) {
      const codePoint = Number.parseInt(digits, 16);
      if (codePoint <= 0x10ffff) {
        return {
          end: digitsStart + digitsLength,
          value: String.fromCodePoint(codePoint),
          uncertain: false,
        };
      }
    }
    return { end: Math.min(sql.length, index + 2), value: next ?? '', uncertain: true };
  }

  if (simpleEscapes.has(next)) {
    return { end: index + 2, value: simpleEscapes.get(next), uncertain: false };
  }
  if (next === '\n' || next === '\r') {
    const consumesPair = next === '\r' && sql[index + 2] === '\n';
    return { end: index + (consumesPair ? 3 : 2), value: '', uncertain: false };
  }
  if (/[0-7]/u.test(next ?? '')) {
    const digits = /^[0-7]{1,3}/u.exec(sql.slice(index + 1))?.[0] ?? '';
    return {
      end: index + 1 + digits.length,
      value: String.fromCodePoint(Number.parseInt(digits, 8)),
      uncertain: false,
    };
  }
  if (next === 'x') {
    const digits = /^[0-9a-f]{1,2}/iu.exec(sql.slice(index + 2))?.[0];
    if (digits) {
      return {
        end: index + 2 + digits.length,
        value: String.fromCodePoint(Number.parseInt(digits, 16)),
        uncertain: false,
      };
    }
  }
  if (next === 'u' || next === 'U') {
    const digitsLength = next === 'u' ? 4 : 8;
    const digits = sql.slice(index + 2, index + 2 + digitsLength);
    if (new RegExp(`^[0-9a-f]{${digitsLength}}$`, 'iu').test(digits)) {
      const codePoint = Number.parseInt(digits, 16);
      if (codePoint <= 0x10ffff) {
        return {
          end: index + 2 + digitsLength,
          value: String.fromCodePoint(codePoint),
          uncertain: false,
        };
      }
    }
  }
  return { end: Math.min(sql.length, index + 2), value: next ?? '', uncertain: false };
}

function readQuoted(sql, quoteIndex, quote, escapeMode = 'none') {
  let value = '';
  let uncertainEscape = false;
  let index = quoteIndex + 1;
  while (index < sql.length) {
    if (escapeMode !== 'none' && sql[index] === '\\' && index + 1 < sql.length) {
      const escape = readEscapeSequence(sql, index, escapeMode);
      value += escape.value;
      uncertainEscape ||= escape.uncertain;
      index = escape.end;
    } else if (sql[index] !== quote) {
      value += sql[index];
      index += 1;
    } else if (sql[index + 1] === quote) {
      value += quote;
      index += 2;
    } else {
      return { end: index + 1, uncertainEscape, value };
    }
  }
  return { end: sql.length, uncertainEscape, value };
}

function tokenizeSql(sql) {
  const tokens = [];
  let index = 0;

  while (index < sql.length) {
    if (/\s/u.test(sql[index])) {
      index += 1;
      continue;
    }
    if (sql.startsWith('--', index)) {
      const lineEnd = sql.indexOf('\n', index + 2);
      index = lineEnd < 0 ? sql.length : lineEnd + 1;
      continue;
    }
    if (sql.startsWith('/*', index)) {
      let depth = 1;
      index += 2;
      while (index < sql.length && depth > 0) {
        if (sql.startsWith('/*', index)) {
          depth += 1;
          index += 2;
        } else if (sql.startsWith('*/', index)) {
          depth -= 1;
          index += 2;
        } else {
          index += 1;
        }
      }
      continue;
    }
    if (
      (sql[index] === 'E' || sql[index] === 'e') &&
      sql[index + 1] === "'" &&
      (index === 0 || !isIdentifierPart(sql[index - 1]))
    ) {
      const quoted = readQuoted(sql, index + 1, "'", 'escape');
      tokens.push({
        type: 'string',
        kind: 'escape',
        uncertainEscape: quoted.uncertainEscape,
        value: quoted.value,
      });
      index = quoted.end;
      continue;
    }
    if (
      (sql[index] === 'U' || sql[index] === 'u') &&
      sql[index + 1] === '&' &&
      (sql[index + 2] === "'" || sql[index + 2] === '"') &&
      (index === 0 || !isIdentifierPart(sql[index - 1]))
    ) {
      const quote = sql[index + 2];
      const quoted = readQuoted(sql, index + 2, quote, 'unicode');
      tokens.push({
        type: quote === '"' ? 'identifier' : 'string',
        kind: 'unicode',
        uncertainEscape: quoted.uncertainEscape,
        value: quoted.value,
      });
      index = quoted.end;
      continue;
    }
    if (sql[index] === "'") {
      const quoted = readQuoted(sql, index, "'");
      tokens.push({ type: 'string', kind: 'single', value: quoted.value });
      index = quoted.end;
      continue;
    }
    if (sql[index] === '"') {
      const quoted = readQuoted(sql, index, '"');
      tokens.push({ type: 'identifier', value: quoted.value });
      index = quoted.end;
      continue;
    }
    if (sql[index] === '$') {
      const delimiter = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/u.exec(sql.slice(index))?.[0];
      if (delimiter) {
        const valueStart = index + delimiter.length;
        const closingIndex = sql.indexOf(delimiter, valueStart);
        const valueEnd = closingIndex < 0 ? sql.length : closingIndex;
        tokens.push({ type: 'string', kind: 'dollar', value: sql.slice(valueStart, valueEnd) });
        index = closingIndex < 0 ? sql.length : closingIndex + delimiter.length;
        continue;
      }
    }
    if (isIdentifierStart(sql[index])) {
      const start = index;
      index += 1;
      while (isIdentifierPart(sql[index])) {
        index += 1;
      }
      tokens.push({ type: 'word', value: sql.slice(start, index).toUpperCase() });
      continue;
    }
    tokens.push({ type: 'symbol', value: sql[index] });
    index += 1;
  }

  return tokens;
}

function isWord(token, value) {
  return token?.type === 'word' && token.value === value;
}

function splitStatements(tokens) {
  const statements = [];
  let statement = [];
  for (const token of tokens) {
    if (token.type === 'symbol' && token.value === ';') {
      if (statement.length > 0) {
        statements.push(statement);
      }
      statement = [];
    } else {
      statement.push(token);
    }
  }
  if (statement.length > 0) {
    statements.push(statement);
  }
  return statements;
}

function hasUnisolatedConcurrentDropIndex(tokens) {
  const statements = splitStatements(tokens);
  if (statements.length <= 1) {
    return false;
  }

  return statements.some((statement) =>
    statement.some(
      (token, index) =>
        isWord(token, 'DROP') &&
        isWord(statement[index + 1], 'INDEX') &&
        isWord(statement[index + 2], 'CONCURRENTLY'),
    ),
  );
}

function analyzeTokenStream(tokens) {
  const result = {
    destructive: false,
    deletesRows: false,
    dropsColumn: false,
    dynamicSql: false,
    nonConcurrentIndex: false,
  };

  for (const statement of splitStatements(tokens)) {
    const altersTable = statement.some(
      (token, index) =>
        isWord(token, 'ALTER') &&
        (isWord(statement[index + 1], 'TABLE') ||
          (isWord(statement[index + 1], 'FOREIGN') && isWord(statement[index + 2], 'TABLE'))),
    );
    for (let index = 0; index < statement.length; index += 1) {
      const token = statement[index];
      if (isWord(token, 'TRUNCATE')) {
        result.destructive = true;
      }
      if (isWord(token, 'DELETE') && isWord(statement[index + 1], 'FROM')) {
        result.destructive = true;
        result.deletesRows = true;
      }
      if (
        isWord(token, 'DROP') &&
        (isWord(statement[index + 1], 'TABLE') || isWord(statement[index + 1], 'TYPE'))
      ) {
        result.destructive = true;
      }
      if (isWord(token, 'EXECUTE')) {
        result.dynamicSql = true;
        result.destructive = true;
        result.dropsColumn = true;
      }
      if (isWord(token, 'CREATE')) {
        let nextIndex = index + 1;
        if (isWord(statement[nextIndex], 'UNIQUE')) {
          nextIndex += 1;
        }
        if (
          isWord(statement[nextIndex], 'INDEX') &&
          !isWord(statement[nextIndex + 1], 'CONCURRENTLY')
        ) {
          result.nonConcurrentIndex = true;
        }
      }
      if (!altersTable || !isWord(token, 'DROP')) {
        continue;
      }

      const follower = statement[index + 1];
      const dropsColumn =
        isWord(follower, 'COLUMN') ||
        (isWord(follower, 'IF') && isWord(statement[index + 2], 'EXISTS')) ||
        follower?.type === 'identifier' ||
        (follower?.type === 'word' && !nonColumnAlterDropWords.has(follower.value));
      if (dropsColumn) {
        result.destructive = true;
        result.dropsColumn = true;
      }
    }
  }

  return result;
}

function executableSqlBodies(tokens) {
  const bodies = [];
  for (const statement of splitStatements(tokens)) {
    const firstWord = statement.find((token) => token.type === 'word');
    const isDoBlock = isWord(firstWord, 'DO');
    const createsRoutine = statement.some(
      (token, index) =>
        isWord(token, 'CREATE') &&
        (isWord(statement[index + 1], 'FUNCTION') ||
          isWord(statement[index + 1], 'PROCEDURE') ||
          (isWord(statement[index + 1], 'OR') &&
            isWord(statement[index + 2], 'REPLACE') &&
            (isWord(statement[index + 3], 'FUNCTION') ||
              isWord(statement[index + 3], 'PROCEDURE')))),
    );
    const hasDynamicSql = statement.some((token) => isWord(token, 'EXECUTE'));
    const hasCustomUnicodeEscape = statement.some((token) => isWord(token, 'UESCAPE'));
    let sawRoutineBodyMarker = false;

    for (let index = 0; index < statement.length; index += 1) {
      const token = statement[index];
      if (createsRoutine && isWord(token, 'AS')) {
        sawRoutineBodyMarker = true;
        continue;
      }
      if (
        token.type === 'string' &&
        (isDoBlock || hasDynamicSql || (createsRoutine && sawRoutineBodyMarker))
      ) {
        let body = token.value;
        let requiresManualReview =
          Boolean(token.uncertainEscape) || (token.kind === 'unicode' && hasCustomUnicodeEscape);
        while (statement[index + 1]?.type === 'string') {
          index += 1;
          body += statement[index].value;
          requiresManualReview ||=
            Boolean(statement[index].uncertainEscape) ||
            (statement[index].kind === 'unicode' && hasCustomUnicodeEscape);
        }
        bodies.push({ requiresManualReview, sql: body });
      }
    }
  }
  return bodies;
}

function mergeSqlAnalysis(target, source) {
  for (const key of Object.keys(target)) {
    target[key] ||= source[key];
  }
}

export function analyzePrismaMigrationSql(sql) {
  const result = {
    destructive: false,
    deletesRows: false,
    dropsColumn: false,
    dynamicSql: false,
    nonConcurrentIndex: false,
  };
  const pending = [sql];

  while (pending.length > 0) {
    const tokens = tokenizeSql(pending.pop());
    mergeSqlAnalysis(result, analyzeTokenStream(tokens));
    for (const body of executableSqlBodies(tokens)) {
      if (body.requiresManualReview) {
        result.dynamicSql = true;
        result.destructive = true;
        result.dropsColumn = true;
      }
      pending.push(body.sql);
    }
  }

  return result;
}

function digestNames(names) {
  return createHash('sha256')
    .update(`${names.join('\n')}\n`)
    .digest('hex');
}

function digestMigrationContents(migrationsRoot, names) {
  const hash = createHash('sha256');
  for (const name of names) {
    hash.update(name);
    hash.update('\0');
    hash.update(readFileSync(resolve(migrationsRoot, name, 'migration.sql')));
    hash.update('\0');
  }
  return hash.digest('hex');
}

export function findPrismaMigrationViolations(
  root,
  immutablePolicyPrefix = IMMUTABLE_PRISMA_POLICY_PREFIX,
) {
  const violations = [];
  const migrationsRoot = resolve(root, 'apps/api/prisma/migrations');
  const policy = JSON.parse(
    readFileSync(resolve(root, 'config/prisma-migration-policy.json'), 'utf8'),
  );
  const names = readdirSync(migrationsRoot)
    .filter((name) => statSync(resolve(migrationsRoot, name)).isDirectory())
    .sort();

  if (!migrationNamePattern.test(policy.policyRulesAfter ?? '')) {
    violations.push('Prisma migration policyRulesAfter is missing or invalid.');
  } else if (policy.policyRulesAfter !== immutablePolicyPrefix.rulesAfter) {
    violations.push(
      `Prisma migration policyRulesAfter must remain ${immutablePolicyPrefix.rulesAfter}; advance only the immutable baseline.`,
    );
  }
  if (!migrationNamePattern.test(policy.baselineThrough ?? '')) {
    violations.push('Prisma migration baselineThrough is missing or invalid.');
  }

  for (const name of names) {
    const migrationPath = resolve(migrationsRoot, name, 'migration.sql');
    if (!migrationNamePattern.test(name)) {
      violations.push(`Invalid Prisma migration directory name: ${name}`);
    }
    if (!existsSync(migrationPath) || statSync(migrationPath).size === 0) {
      violations.push(`Prisma migration is missing a non-empty migration.sql: ${name}`);
      continue;
    }

    const migrationSql = readFileSync(migrationPath, 'utf8');
    const analysis = analyzePrismaMigrationSql(migrationSql);
    const isNewPolicyMigration = name > immutablePolicyPrefix.rulesAfter;
    if (!isNewPolicyMigration) {
      continue;
    }

    if (hasUnisolatedConcurrentDropIndex(tokenizeSql(migrationSql))) {
      violations.push(
        `${name} combines DROP INDEX CONCURRENTLY with another statement; isolate it because Prisma cannot safely split this PostgreSQL syntax.`,
      );
    }

    if (
      analysis.nonConcurrentIndex &&
      !policy.nonConcurrentIndexExceptions?.[name]?.reason?.trim()
    ) {
      violations.push(
        `${name} creates an index without CONCURRENTLY and has no documented policy exception.`,
      );
    }
    const approval = policy.approvedDestructive?.[name];
    if (analysis.destructive) {
      if (!approval?.reason?.trim()) {
        violations.push(`${name} contains destructive SQL without an approved policy record.`);
      }
      if (
        (analysis.dropsColumn || analysis.deletesRows) &&
        (!approval?.twoPhaseRelease || !approval?.runtimeCompatibilityEvidence?.trim())
      ) {
        const destructiveAction = analysis.dropsColumn ? 'drops a column' : 'deletes rows';
        violations.push(
          `${name} ${destructiveAction} without two-phase release compatibility evidence.`,
        );
      }
    }
    if (analysis.dynamicSql && !approval?.reason?.trim()) {
      violations.push(
        `${name} contains executable SQL that requires a documented manual policy review.`,
      );
    }
  }

  const immutablePrefixNames = names.filter((name) => name <= immutablePolicyPrefix.rulesAfter);
  if (digestNames(immutablePrefixNames) !== immutablePolicyPrefix.namesSha256) {
    violations.push(
      'Prisma migration bootstrap prefix names changed. Restore the fixed pre-policy history instead of adding backdated migrations.',
    );
  }
  const immutablePrefixContentsComplete = immutablePrefixNames.every((name) =>
    existsSync(resolve(migrationsRoot, name, 'migration.sql')),
  );
  if (
    immutablePrefixContentsComplete &&
    digestMigrationContents(migrationsRoot, immutablePrefixNames) !==
      immutablePolicyPrefix.contentsSha256
  ) {
    violations.push(
      'Prisma migration bootstrap prefix SQL changed. Restore the fixed pre-policy migration contents.',
    );
  }

  const baselineNames = names.filter((name) => name <= policy.baselineThrough);
  if (names.at(-1) !== policy.baselineThrough) {
    violations.push(
      'Prisma migration baselineThrough must match the latest migration so every committed SQL file is immutable.',
    );
  }
  const baselineDigest = digestNames(baselineNames);
  if (baselineDigest !== policy.baselineNamesSha256) {
    violations.push(
      'Historical Prisma migration names changed. Restore the baseline instead of editing or backdating migrations.',
    );
  }
  const baselineContentsComplete = baselineNames.every((name) =>
    existsSync(resolve(migrationsRoot, name, 'migration.sql')),
  );
  const baselineContentsDigest = baselineContentsComplete
    ? digestMigrationContents(migrationsRoot, baselineNames)
    : null;
  if (baselineContentsDigest !== null && baselineContentsDigest !== policy.baselineContentsSha256) {
    violations.push(
      'Historical Prisma migration SQL changed. Restore the immutable migration contents instead of editing applied history.',
    );
  }

  for (const name of Object.keys(policy.approvedDestructive ?? {})) {
    const migrationPath = resolve(migrationsRoot, name, 'migration.sql');
    if (!existsSync(migrationPath)) {
      violations.push(`Destructive migration policy references a missing migration: ${name}`);
      continue;
    }
    const analysis = analyzePrismaMigrationSql(readFileSync(migrationPath, 'utf8'));
    if (!analysis.destructive && !analysis.dynamicSql) {
      violations.push(`Destructive migration policy entry is stale: ${name}`);
    }
  }

  return violations;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const root = resolve(import.meta.dirname, '..');
  const violations = findPrismaMigrationViolations(root);
  for (const violation of violations) {
    console.error(violation);
  }
  if (violations.length > 0) {
    process.exitCode = 1;
  }
}
