const { createHash } = require('node:crypto');
const ts = require('typescript');

const TRANSFORMER_VERSION = '1';
const compilerOptions = {
  allowJs: true,
  checkJs: false,
  esModuleInterop: true,
  inlineSourceMap: true,
  inlineSources: true,
  module: ts.ModuleKind.CommonJS,
  target: ts.ScriptTarget.ES2022,
};

module.exports = {
  getCacheKey(sourceText, sourcePath, transformOptions) {
    return createHash('sha256')
      .update(TRANSFORMER_VERSION)
      .update(ts.version)
      .update(sourcePath)
      .update(sourceText)
      .update(transformOptions.configString)
      .digest('hex');
  },
  process(sourceText, sourcePath) {
    const result = ts.transpileModule(sourceText, {
      compilerOptions,
      fileName: sourcePath,
      reportDiagnostics: false,
    });
    return { code: result.outputText };
  },
};
