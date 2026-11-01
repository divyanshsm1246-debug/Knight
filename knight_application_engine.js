<!-- ... existing code ... -->
    if (ch === ')' || ch === ']' || ch === '}') {
      const top = stack[stack.length - 1];
      if (ch === '}' && top && top.t === 'tpl') { stack.pop(); adv(); scanTemplate(top.line, top.col); continue; }
      if (strErr) { fatal = true; break; }
      if (!top) { err(line, col, "Unexpected '" + ch + "' with nothing open to close."); fatal = true; break; }
      if (top.ch !== pairs[ch]) {
        err(line, col, "Found '" + ch + "' but the '" + top.ch + "' opened on line " + top.line + ' is still open.');
        fatal = true; break;
      }
      stack.pop(); lastSig = ch; adv(); continue;
    }
    if (/[A-Za-z_$]/.test(ch)) { let w = ''; while (i < n && /[\w$]/.test(src[i])) { w += src[i]; adv(); }
      lastWord = w; lastSig = 'a'; continue;
    }
    lastSig = ch; adv();
  }

  if (!fatal && stack.length) {
    const top = stack[stack.length - 1];
    err(top.line, top.col, "The '" + (top.ch || '${') + "' opened on line " + top.line + " is never closed.");
  }
  return { issues, lineDepth, lineInStr };
}

/** Parses JavaScript source with Function() to get exact V8 / SpiderMonkey line numbers for syntax errors. */
function checkJsSyntax(src) {
  try {
    // Wrap in async function to allow await at top-level
    new Function('return (async () => {\n' + src + '\n})');
    return [];
  } catch (e) {
    if (e instanceof SyntaxError) {
      let line = 1, col = 1;
      const m = /(?:<anonymous>|eval|Function):(\d+):(\d+)/.exec(e.stack || '');
      if (m) {
        line = Math.max(1, parseInt(m[1], 10) - 1);
        col = parseInt(m[2], 10);
      }
      return [{ line, col, severity: 'error', message: e.message }];
    }
    return [];
  }
}

/** Basic Python static checks (indentation consistency and missing colons before blocks). */
function checkPythonSyntax(src) {
  const issues = [], lines = src.split('\n');
  let firstIndent = null;
  lines.forEach((l, idx) => {
    const lineNum = idx + 1;
    const trimmed = l.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const indent = l.search(/\S/);
    if (indent > 0) {
      const type = l.slice(0, indent).includes('\t') ? 'tabs' : 'spaces';
      if (!firstIndent) firstIndent = type;
      else if (firstIndent !== type) {
        issues.push({ line: lineNum, col: 1, severity: 'warn', message: 'Mixed tabs and spaces in indentation.' });
      }
    }
    if (/\b(if|elif|else|for|while|def|class|try|except|finally|with)\b.*[^:]$/.test(trimmed) && !trimmed.endsWith('\\')) {
      issues.push({ line: lineNum, col: l.length, severity: 'error', message: 'Missing colon ":" at the end of block header.' });
    }
  });
  return issues;
}

/** Basic HTML structural tag matching check. */
function checkHtmlSyntax(src) {
  const issues = [], stack = [], lines = src.split('\n');
  const selfClosing = new Set(['area','base','br','col','embed','hr','img','input','link','meta','param','source','track','wbr']);
  const tagRe = /<\/?([a-zA-Z0-9\-]+)[^>]*>/g;
  let m;
  while ((m = tagRe.exec(src)) !== null) {
    const full = m[0], tag = m[1].toLowerCase();
    if (full.startsWith('<!--') || full.startsWith('<!') || full.endsWith('/>') || selfClosing.has(tag)) continue;
    const line = src.slice(0, m.index).split('\n').length;
    if (full.startsWith('</')) {
      if (!stack.length) {
        issues.push({ line, col: 1, severity: 'error', message: `Unexpected closing tag </${tag}> with no matching opening tag.` });
      } else {
        const top = stack.pop();
        if (top.tag !== tag) {
          issues.push({ line, col: 1, severity: 'error', message: `Expected closing tag </${top.tag}> for tag opened at line ${top.line}, but found </${tag}>.` });
        }
      }
    } else {
      stack.push({ tag, line });
    }
  }
  return issues;
}

/** Unified lint entry point for any file content. */
function lintSource(kind, src, opts = {}) {
  const cfg = LINT_CFG[kind] || LINT_CFG.js;
  let issues = [];

  if (kind === 'json') {
    try { JSON.parse(src); } catch (e) {
      const m = /position (\d+)/.exec(e.message);
      let line = 1, col = 1;
      if (m) {
        const pos = parseInt(m[1], 10);
        line = src.slice(0, pos).split('\n').length;
        col = pos - src.slice(0, pos).lastIndexOf('\n');
      }
      issues.push({ line, col, severity: 'error', message: e.message });
    }
    return issues;
  }

  if (kind === 'html') return checkHtmlSyntax(src);
  if (kind === 'py') issues = checkPythonSyntax(src);

  const bracketRes = scanBrackets(src, cfg);
  issues.push(...bracketRes.issues);

  if (kind === 'js' && !opts.ts && !bracketRes.issues.length) {
    issues.push(...checkJsSyntax(src));
  }
  return issues;
}

function lintKindForFile(name) {
  return LINT_BY_EXT[extOf(name)] || null;
}

/** Run live lint checks on the terminal code input area. */
function checkTermCodeUI(silent = false) {
  const code = $('termCodeInput')?.value || '';
  const lang = $('termLanguage')?.value || 'javascript';
  const kind = LINT_BY_TERM_LANG[lang] || 'js';
  const issues = lintSource(kind, code);
  const hintBox = $('termJump');
  if (!hintBox) return issues;

  if (!issues.length) {
    hintBox.innerHTML = silent ? '' : `<span style="color:var(--accent-green);font-size:.78rem;">✓ No static syntax errors detected.</span>`;
    return [];
  }

  const err = issues[0];
  hintBox.innerHTML = `<div class="term-error-banner" onclick="termGotoLine(${err.line})">
    ⚠ Line ${err.line}: ${esc(err.message)} <span style="text-decoration:underline;margin-left:6px;">Jump to line</span>
  </div>`;
  return issues;
}

function termGotoLine(line) {
  const box = $('termCodeInput');
  if (!box) return;
  const lines = box.value.split('\n');
  let pos = 0;
  for (let i = 0; i < Math.min(line - 1, lines.length); i++) {
    pos += lines[i].length + 1;
  }
  box.focus();
  box.setSelectionRange(pos, pos + (lines[line - 1] || '').length);
}

function showJumpToErrorLine(errMsg, offset = 0) {
  const m = /(?:line|at)\s*:?(\d+)/i.exec(errMsg);
  if (!m) return;
  const line = parseInt(m[1], 10) + offset;
  const hintBox = $('termJump');
  if (hintBox) {
    hintBox.innerHTML = `<div class="term-error-banner" onclick="termGotoLine(${line})">
      ▶ Runtime Error at Line ${line}. Click to jump to line.
    </div>`;
  }
}