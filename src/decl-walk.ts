// Declarations in one Lezer syntax tree (S-1532, go to declaration). Pure and import-free, so the daemon's index
// worker (src/decl-worker.ts) and the web's same-file fallback (web/src/decl/) walk trees the same way. A node is
// anything shaped like Lezer's SyntaxNode, so the web passes CodeMirror's tree and the daemon its own @lezer parsers'.

export interface DeclNode {
  name: string;
  from: number;
  to: number;
  readonly firstChild: DeclNode | null;
  readonly nextSibling: DeclNode | null;
}

export type DeclKind = 'function' | 'class' | 'interface' | 'type' | 'enum' | 'const' | 'let' | 'var' | 'method' | 'export' | 'module' | 'struct' | 'trait' | 'macro';
// One declaration: `from` is the name's offset in the text.
export interface Decl { name: string; kind: DeclKind; from: number }
// The grammars with declaration nodes clear enough to index. CSS, HTML, JSON, YAML, Markdown and shell have none.
export type DeclLang = 'js' | 'python' | 'rust' | 'go';

const EXT: Record<string, { lang: DeclLang; dialect?: string }> = {
  ts: { lang: 'js', dialect: 'ts' }, mts: { lang: 'js', dialect: 'ts' }, cts: { lang: 'js', dialect: 'ts' }, tsx: { lang: 'js', dialect: 'ts jsx' },
  js: { lang: 'js' }, mjs: { lang: 'js' }, cjs: { lang: 'js' }, jsx: { lang: 'js', dialect: 'jsx' },
  py: { lang: 'python' }, pyi: { lang: 'python' }, rs: { lang: 'rust' }, go: { lang: 'go' },
};

// The grammar (and the JS parser's dialect) for a path, or null when it has no indexable declarations.
export function declLangOf(path: string): { lang: DeclLang; dialect?: string } | null {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  const dot = name.lastIndexOf('.');
  return dot > 0 ? EXT[name.slice(dot + 1)] ?? null : null;
}

function* kids(n: DeclNode): Generator<DeclNode> {
  for (let c = n.firstChild; c; c = c.nextSibling) yield c;
}
const child = (n: DeclNode, ...names: string[]): DeclNode | null => {
  for (const c of kids(n)) if (names.includes(c.name)) return c;
  return null;
};

// The identifier nodes a reader can click, per grammar: what web/src/decl/ reads a name from.
export const IDENT_NODES = new Set([
  'VariableName', 'VariableDefinition', 'TypeName', 'TypeDefinition', 'PropertyName', 'PropertyDefinition', 'PrivatePropertyDefinition', 'PrivatePropertyName', 'JSXIdentifier', 'Label',
  'BoundIdentifier', 'TypeIdentifier', 'Identifier', 'FieldIdentifier', 'ScopeIdentifier',
  'DefName', 'FieldName',
]);

export function walkDecls(lang: DeclLang, top: DeclNode, text: string): Decl[] {
  const out: Decl[] = [];
  const add = (n: DeclNode | null, kind: DeclKind) => { if (n && n.to > n.from) out.push({ name: text.slice(n.from, n.to), kind, from: n.from }); };
  if (lang === 'js') js(top, add, text);
  else if (lang === 'python') python(top, add, false);
  else if (lang === 'rust') rust(top, add, false);
  else go(top, add);
  return out;
}

type Add = (n: DeclNode | null, kind: DeclKind) => void;

// Statements at the top of a script, in `export`, `declare` and namespace blocks; members of class bodies.
function js(n: DeclNode, add: Add, text: string): void {
  for (const c of kids(n)) {
    switch (c.name) {
      case 'ExportDeclaration': {
        const group = child(c, 'ExportGroup');
        // `export { a as b }`: b is a name this module declares. A plain `export { a }` names a declaration already indexed.
        if (group) {
          let prev: DeclNode | null = null;
          for (const g of kids(group)) {
            if (prev?.name === 'as' && (g.name === 'VariableName' || g.name === 'VariableDefinition')) add(g, 'export');
            prev = g;
          }
        }
        js(c, add, text);
        break;
      }
      case 'AmbientDeclaration': js(c, add, text); break;
      case 'FunctionDeclaration': case 'AmbientFunctionDeclaration': add(child(c, 'VariableDefinition'), 'function'); break;
      case 'ClassDeclaration': {
        add(child(c, 'VariableDefinition', 'TypeDefinition'), 'class');
        const body = child(c, 'ClassBody');
        if (body) for (const m of kids(body)) if (m.name === 'MethodDeclaration') add(child(m, 'PropertyDefinition', 'PrivatePropertyDefinition'), 'method');
        break;
      }
      case 'InterfaceDeclaration': add(child(c, 'TypeDefinition'), 'interface'); break;
      case 'TypeAliasDeclaration': add(child(c, 'TypeDefinition'), 'type'); break;
      case 'EnumDeclaration': add(child(c, 'TypeDefinition'), 'enum'); break;
      case 'NamespaceDeclaration': {
        add(child(c, 'VariableDefinition'), 'module');
        const block = child(c, 'Block');
        if (block) js(block, add, text);
        break;
      }
      case 'VariableDeclaration': {
        const kw = c.firstChild;
        const kind: DeclKind = kw && (kw.name === 'let' || kw.name === 'var') ? kw.name : 'const';
        pattern(c, add, kind);
        break;
      }
    }
  }
}

// The names a declaration's patterns bind, not those inside its initialisers (an arrow function's parameters).
function pattern(n: DeclNode, add: Add, kind: DeclKind): void {
  for (const c of kids(n)) {
    if (c.name === 'VariableDefinition') add(c, kind);
    else if (c.name === 'ObjectPattern' || c.name === 'ArrayPattern' || c.name === 'PatternProperty') pattern(c, add, kind);
  }
}

function python(n: DeclNode, add: Add, inClass: boolean): void {
  for (const c of kids(n)) {
    switch (c.name) {
      case 'DecoratedStatement': python(c, add, inClass); break;
      case 'FunctionDefinition': add(child(c, 'VariableName'), inClass ? 'method' : 'function'); break;
      case 'ClassDefinition': {
        add(child(c, 'VariableName'), 'class');
        const body = child(c, 'Body');
        if (body) python(body, add, true);
        break;
      }
      case 'AssignStatement':
        // `a, b = …` and `X: int = …`: the names before the first operator or annotation.
        if (inClass) break;
        for (const v of kids(c)) {
          if (v.name === 'VariableName') add(v, 'var');
          else if (v.name !== ',') break;
        }
        break;
    }
  }
}

const RUST: Record<string, DeclKind> = { FunctionItem: 'function', StructItem: 'struct', UnionItem: 'struct', EnumItem: 'enum', TraitItem: 'trait', TypeItem: 'type', ConstItem: 'const', StaticItem: 'var', ModItem: 'module', MacroDefinition: 'macro' };

function rust(n: DeclNode, add: Add, inImpl: boolean): void {
  for (const c of kids(n)) {
    const kind = RUST[c.name];
    if (kind) add(child(c, 'BoundIdentifier', 'TypeIdentifier', 'Identifier'), kind === 'function' && inImpl ? 'method' : kind);
    if (c.name === 'ModItem' || c.name === 'ImplItem' || c.name === 'TraitItem') {
      const list = child(c, 'DeclarationList');
      if (list) rust(list, add, c.name !== 'ModItem');
    }
  }
}

function go(n: DeclNode, add: Add): void {
  for (const c of kids(n)) {
    switch (c.name) {
      case 'FunctionDecl': add(child(c, 'DefName'), 'function'); break;
      case 'MethodDecl': add(child(c, 'FieldName'), 'method'); break;
      case 'TypeDecl': case 'ConstDecl': case 'VarDecl': {
        const specs = child(c, 'SpecList') ?? c;
        for (const s of kids(specs)) {
          if (s.name === 'TypeSpec' || s.name === 'AliasDecl') {
            const t = child(s, 'StructType', 'InterfaceType');
            add(child(s, 'DefName'), t?.name === 'StructType' ? 'struct' : t?.name === 'InterfaceType' ? 'interface' : 'type');
          } else if (s.name === 'ConstSpec' || s.name === 'VarSpec') {
            for (const d of kids(s)) if (d.name === 'DefName') add(d, s.name === 'ConstSpec' ? 'const' : 'var');
          }
        }
        break;
      }
    }
  }
}

// The relative module specifiers a file imports, as written (`./x.ts`, `.mod`), for ranking. JS only reads
// `import … from` and `export … from`; Python reads `from .x import` and `import a.b`.
export function walkImports(lang: DeclLang, top: DeclNode, text: string): string[] {
  const out: string[] = [];
  if (lang === 'js') {
    for (const c of kids(top)) {
      if (c.name !== 'ImportDeclaration' && c.name !== 'ExportDeclaration') continue;
      const s = child(c, 'String');
      if (s) out.push(text.slice(s.from + 1, s.to - 1));
    }
  } else if (lang === 'python') {
    for (const c of kids(top)) {
      if (c.name !== 'ImportStatement') continue;
      // `from . x import y` reads as tokens: dots, then the dotted name up to `import`. In `import a as b, c` an alias
      // is skipped up to the next comma.
      let spec = '';
      let alias = false;
      for (const t of kids(c)) {
        if (t.name === 'from') continue;
        if (t.name === 'import') { if (spec) break; continue; }
        if (t.name === ',') { if (spec) out.push(spec); spec = ''; alias = false; continue; }
        if (t.name === 'as') { alias = true; continue; }
        if (!alias) spec += text.slice(t.from, t.to);
      }
      if (spec) out.push(spec);
    }
  }
  return out;
}
