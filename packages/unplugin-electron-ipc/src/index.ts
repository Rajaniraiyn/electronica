import MagicString from "magic-string";
import crypto from "node:crypto";
import path from "node:path";
import ts from "typescript";
import type { UnpluginFactory } from 'unplugin';
import { createUnplugin } from 'unplugin';
import { name } from "../package.json";

/**
 * Generate a stable short hash (12 hex digits) from some text.
 */
function createHashForText(text: string) {
    return crypto.createHash("sha256").update(text).digest("hex").slice(0, 12)
  }
  

export interface Options {
    context: "renderer" | "main"
}

/**
 * A structure to hold info about exported functions we want to transform.
 */
interface ExportedFunction {
    name: string
    start: number
    end: number
    isAsync: boolean
    originalBodyCode: string
    isDefault?: boolean
}

export const unpluginFactory: UnpluginFactory<Options> = ({ context }) => ({
    name: name,
    transformInclude: (id) => {
        // We only care about .ipc.ts/.ipc.js files
        if (!/\.ipc\.(t|j)s$/.test(id)) {
            return false
        }

        const isMainIpcFile = /\.main\.ipc\.(t|j)s$/.test(id)
        const isRendererIpcFile = /\.renderer\.ipc\.(t|j)s$/.test(id)

        // Determine whether to transform or skip:
        //   context === "main": transform if file is .main.ipc or .renderer.ipc
        //   context === "renderer": likewise
        const shouldTransform =
            (context === "main" && (isMainIpcFile || isRendererIpcFile)) ||
            (context === "renderer" && (isMainIpcFile || isRendererIpcFile))

        if (!shouldTransform) {
            // If this file is for the other context, produce null to skip transform
            return false
        }

        return true
    },
    transform: (source, id) => {
        const isMainIpcFile = /\.main\.ipc\.(t|j)s$/.test(id)
        const isRendererIpcFile = /\.renderer\.ipc\.(t|j)s$/.test(id)

        // 1) Parse with TS compiler API
        const sourceFile = ts.createSourceFile(
            id,
            source,
            ts.ScriptTarget.ESNext,
            true // setParentNodes
        )

        const magicStr = new MagicString(source)
        const exportedFns: ExportedFunction[] = []

        // 2) Traverse the AST to find exported function declarations
        //    including default exports and "export const foo = () => {...}" etc.
        const visit = (node: ts.Node) => {
            // Check if node is an export: 
            //   - `export function foo()...`
            //   - `export default function foo()...`
            //   - `export const foo = ...`
            // or similarly for arrow functions.
            if (ts.canHaveModifiers(node) && node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) {
                // e.g. "export async function foo() { ... }" or "export default function foo() { ... }"
                if (ts.isFunctionDeclaration(node)) {
                    // If it's a default export without a name
                    // e.g. `export default function () { ... }` 
                    // we might generate an internal name. 
                    // But let's handle it more simply: skip if no name. 
                    if (node.name) {
                        const { name, pos, end } = node
                        const isAsync = node.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)
                        const originalBodyCode = source.slice(pos, end)
                        const isDefault = node.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)

                        exportedFns.push({
                            name: name.text,
                            start: pos,
                            end,
                            isAsync: !!isAsync,
                            originalBodyCode,
                            isDefault,
                        })
                    } else {
                        // "export default function() { ... }" (anonymous)
                        // We'll create a synthetic name for it. 
                        const { pos, end } = node
                        const isAsync = node.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)
                        const originalBodyCode = source.slice(pos, end)
                        exportedFns.push({
                            name: "_defaultExport",
                            start: pos,
                            end,
                            isAsync: !!isAsync,
                            originalBodyCode,
                            isDefault: true,
                        })
                    }
                }
                // e.g. "export const foo = async () => {...}"
                else if (ts.isVariableStatement(node)) {
                    // Each declaration in the variable statement
                    for (const decl of node.declarationList.declarations) {
                        if (ts.isIdentifier(decl.name)) {
                            const varName = decl.name.text
                            const init = decl.initializer
                            if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
                                const { pos, end } = init
                                const isAsync =
                                    init.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) || false
                                const originalBodyCode = source.slice(pos, end)
                                const isDefault = node.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)

                                exportedFns.push({
                                    name: varName,
                                    start: pos,
                                    end,
                                    isAsync,
                                    originalBodyCode,
                                    isDefault,
                                })
                            }
                        }
                    }
                }
            }

            ts.forEachChild(node, visit)
        }
        visit(sourceFile)

        // If there are no relevant exports, skip further processing
        if (exportedFns.length === 0) {
          return null
        }

        // 3) Overwrite each exported function's code with the desired logic
        //    Also track which electron APIs we need based on context.
        const electronImportsNeeded = new Set<string>()

        // For .main.ipc => we typically need: ipcMain, webContents
        // For .renderer.ipc => we typically need: ipcRenderer
        // In practice:
        //    - If context=main & file is .main.ipc => we add `ipcMain.handle` / `ipcMain.on`
        //    - If context=main & file is .renderer.ipc => we transform => broadcast via webContents
        //    - If context=renderer & file is .renderer.ipc => we add `ipcRenderer.on(...)`
        //    - If context=renderer & file is .main.ipc => we transform => `ipcRenderer.invoke/sendSync(...)`
    
        for (const fn of exportedFns) {
          const { name, start, end, isAsync, originalBodyCode, isDefault } = fn
    
          // Generate a unique channel name based on the function's body 
          // plus the file+function name to avoid collisions.
          const hashed = createHashForText(originalBodyCode)
          const baseFileName = path.basename(id)
          const channel = `${baseFileName}:${isDefault ? "default" : name}:${hashed}`
    
          if (context === "main") {
            if (isMainIpcFile) {
              // .main.ipc => keep the function in the output, but register an ipcMain handler
              electronImportsNeeded.add("ipcMain")
              if (isAsync) {
                // Wrap the handle in a try/catch to avoid unhandled rejections crashing main
                // This is considered a best practice in production apps.
                const handler = `
    try {
      ipcMain.handle("${channel}", async (event, ...args) => {
        try {
          return await ${name}(...args);
        } catch (err) {
          console.error("Error in IPC handler for channel: ${channel}:", err);
          throw err;
        }
      });
    } catch (e) {
      console.error("Failed to register ipcMain handle for channel: ${channel}", e);
    }`
                magicStr.append(handler)
              } else {
                const handler = `
    try {
      ipcMain.on("${channel}", (event, ...args) => {
        try {
          event.returnValue = ${name}(...args);
        } catch (err) {
          console.error("Error in IPC on for channel: ${channel}:", err);
          // Return an error object, or handle gracefully
          event.returnValue = { error: err?.message };
        }
      });
    } catch (e) {
      console.error("Failed to register ipcMain on for channel: ${channel}", e);
    }`
                magicStr.append(handler)
              }
            } else {
              // .renderer.ipc => transform => broadcast via webContents
              electronImportsNeeded.add("webContents")
              if (isAsync) {
                // Overwrite the original function with code that sends an IPC to all WebContents
                // and awaits the first response.
                magicStr.overwrite(
                  start,
                  end,
                  `
    export async function ${name}(...args) {
      const all = webContents.getAllWebContents();
      return new Promise((resolve, reject) => {
        let resolved = false;
        for (const wc of all) {
          // Listen for just the first successful reply from any webContents
          wc.once("${channel}-reply", (event, resultOrError) => {
            if (!resolved) {
              resolved = true;
              if (resultOrError && resultOrError.__ipcError) {
                reject(new Error(resultOrError.__ipcError));
              } else {
                resolve(resultOrError);
              }
            }
          });
          wc.send("${channel}", ...args);
        }
        // If all windows are closed, this could hang, so you might want a timeout or check
      });
    }`
                )
              } else {
                magicStr.overwrite(
                  start,
                  end,
                  `
    export function ${name}(...args) {
      const all = webContents.getAllWebContents();
      for (const wc of all) {
        wc.send("${channel}", ...args);
      }
    }`
                )
              }
            }
          } else {
            // context === "renderer"
            if (isRendererIpcFile) {
              // .renderer.ipc => keep function + add ipcRenderer.on
              electronImportsNeeded.add("ipcRenderer")
              if (isAsync) {
                magicStr.append(`
    try {
      ipcRenderer.on("${channel}", async (event, ...args) => {
        try {
          const result = await ${name}(...args);
          event.sender.send("${channel}-reply", result);
        } catch (err) {
          console.error("Error in renderer IPC function '${channel}':", err);
          event.sender.send("${channel}-reply", { __ipcError: err?.message });
        }
      });
    } catch (e) {
      console.error("Failed to register ipcRenderer.on for channel: ${channel}", e);
    }`)
              } else {
                magicStr.append(`
    try {
      ipcRenderer.on("${channel}", (event, ...args) => {
        try {
          const result = ${name}(...args);
          event.sender.send("${channel}-reply", result);
        } catch (err) {
          console.error("Error in renderer IPC function '${channel}':", err);
          event.sender.send("${channel}-reply", { __ipcError: err?.message });
        }
      });
    } catch (e) {
      console.error("Failed to register ipcRenderer.on for channel: ${channel}", e);
    }`)
              }
            } else {
              // .main.ipc => transform => use ipcRenderer.invoke or sendSync
              electronImportsNeeded.add("ipcRenderer")
              if (isAsync) {
                magicStr.overwrite(
                  start,
                  end,
                  `
    export async function ${name}(...args) {
      try {
        return await ipcRenderer.invoke("${channel}", ...args);
      } catch (err) {
        console.error("IPC invoke error on channel: ${channel}:", err);
        throw err;
      }
    }`
                )
              } else {
                magicStr.overwrite(
                  start,
                  end,
                  `
    export function ${name}(...args) {
      try {
        return ipcRenderer.sendSync("${channel}", ...args);
      } catch (err) {
        console.error("IPC sendSync error on channel: ${channel}:", err);
        return { error: err?.message };
      }
    }`
                )
              }
            }
          }
        }


    // 4) Insert or merge import statements from "electron"
    const importNodes: ts.ImportDeclaration[] = []
    const existingElectronImports = new Set<string>()

    // Re-run a small parse focusing on top-level ImportDeclarations
    // to detect any existing import from 'electron'
    for (const stmt of sourceFile.statements) {
      if (ts.isImportDeclaration(stmt)) {
        const importDecl = stmt
        const moduleSpec = importDecl.moduleSpecifier.getText(sourceFile).replace(/['"]/g, "")
        if (moduleSpec === "electron") {
          importNodes.push(importDecl)
        }
      }
    }

    // If there's an existing import from 'electron', attempt to merge
    if (importNodes.length > 0) {
      for (const importDecl of importNodes) {
        if (
          importDecl.importClause &&
          importDecl.importClause.namedBindings &&
          ts.isNamedImports(importDecl.importClause.namedBindings)
        ) {
          for (const spec of importDecl.importClause.namedBindings.elements) {
            existingElectronImports.add(spec.name.text)
          }
        }
      }

      // Merge: for each needed import, if not present, we add it
      const firstImportDecl = importNodes[0]
      const startPos = firstImportDecl.getStart()
      const endPos = firstImportDecl.getEnd()
      let importText = source.slice(startPos, endPos)

      // Try naive approach: we look for `import { x, y } from 'electron'`
      const curlyMatch = importText.match(
        /import\s*\{\s*([^}]*)\}\s*from\s*['"]electron['"]/
      )
      if (curlyMatch) {
        // We have a named import statement
        let existingNames = curlyMatch[1]
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)

        // Add any missing
        for (const needed of electronImportsNeeded) {
          if (!existingNames.includes(needed)) {
            existingNames.push(needed)
          }
        }

        // Rebuild
        const newImport = `import { ${existingNames.join(", ")} } from 'electron'`
        importText = importText.replace(curlyMatch[0], newImport)
        magicStr.overwrite(startPos, endPos, importText)
      } else {
        // Potentially it's `import electron from 'electron'`, etc.
        // We'll add named import. 
        const namedList = Array.from(electronImportsNeeded).join(", ")
        if (/import\s+(\w+)\s+from\s+['"]electron['"]/.test(importText)) {
          importText = importText.replace(
            /import\s+(\w+)\s+from\s+['"]electron['"]/,
            `import $1, { ${namedList} } from 'electron'`
          )
          magicStr.overwrite(startPos, endPos, importText)
        } else {
          // If we can't parse it, let's just add a named import after it
          const injection = `\nimport { ${namedList} } from 'electron';`
          magicStr.appendLeft(endPos, injection)
        }
      }
    } else {
      // No import from 'electron' in this file, so we prepend a new one
      const needed = Array.from(electronImportsNeeded).join(", ")
      if (needed) {
        magicStr.prepend(`import { ${needed} } from 'electron';\n`)
      }
    }

    // Generate final output
    const transformedCode = magicStr.toString()
    const map = magicStr.generateMap({ hires: true, source: id })

    return {
      code: transformedCode,
      map,
    }
    }
})

export const unplugin = /* @__PURE__ */ createUnplugin(unpluginFactory)

export default unplugin