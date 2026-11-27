const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const en = JSON.parse(fs.readFileSync('web/src/i18n/locales/en-US.json', 'utf8'));

function flatten(obj, prefix = '') {
  let res = {};
  for (const k in obj) {
    const key = prefix ? prefix + '.' + k : k;
    if (typeof obj[k] === 'object' && obj[k] !== null && !Array.isArray(obj[k])) {
      Object.assign(res, flatten(obj[k], key));
    } else {
      res[key] = obj[k];
    }
  }
  return res;
}

const enFlat = flatten(en);
enFlat['common.deleting'] = 'Deleting...';
enFlat['logs.decryptionFailed'] = '[Decryption Failed]';
enFlat['common.profileName'] = 'Profile Name';
enFlat['common.createdAt'] = 'Created At';

const nonAsciiRegex = /[\u4e00-\u9fa5àáảãạăằắẳẵặâầấẩẫậèéẻẽẹêềếểễệđìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵ]/i;

function walk(dir) {
  let results = [];
  const list = fs.readdirSync(dir);
  list.forEach(file => {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);
    if (stat && stat.isDirectory()) {
      results = results.concat(walk(fullPath));
    } else if (file.endsWith('.ts') || file.endsWith('.tsx')) {
      if (!fullPath.includes('locales') && !fullPath.includes('locales.ts') && !fullPath.includes('timezones.ts')) {
        results.push(fullPath);
      }
    }
  });
  return results;
}

const files = walk('web/src');
let totalReplacements = 0;
let modifiedFiles = 0;

for (const filePath of files) {
  const sourceText = fs.readFileSync(filePath, 'utf8');
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );

  const replacements = [];

  function visit(node) {
    // Check for t("key", "val")
    if (ts.isCallExpression(node)) {
      let isT = false;
      if (ts.isIdentifier(node.expression) && node.expression.text === 't') {
        isT = true;
      } else if (
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 't'
      ) {
        isT = true;
      }

      if (isT && node.arguments.length >= 2) {
        const arg0 = node.arguments[0];
        const arg1 = node.arguments[1];

        if (ts.isStringLiteral(arg0) && ts.isStringLiteral(arg1)) {
          const key = arg0.text;
          const val = arg1.text;

          if (nonAsciiRegex.test(val)) {
            const enText = enFlat[key];
            if (enText) {
              replacements.push({
                start: arg1.getStart(sourceFile),
                end: arg1.getEnd(),
                newText: JSON.stringify(enText)
              });
            } else {
              console.warn(`[WARN] Missing en key: ${key} in ${filePath}`);
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);

  if (replacements.length > 0) {
    replacements.sort((a, b) => b.start - a.start);
    let newText = sourceText;
    for (const r of replacements) {
      newText = newText.slice(0, r.start) + r.newText + newText.slice(r.end);
      totalReplacements++;
    }
    fs.writeFileSync(filePath, newText, 'utf8');
    modifiedFiles++;
  }
}

console.log(`TS AST: Successfully replaced ${totalReplacements} string literals in ${modifiedFiles} files.`);
