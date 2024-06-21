import * as t from '@babel/types'
import * as template from '@babel/template'
import { splitPrefix } from './constants'
import { eliminateUnreferencedIdentifiers } from './eliminateUnreferencedIdentifiers'
import type * as babel from '@babel/core'
import type { CompileAstFn } from './ast'

type SplitModulesById = Record<
  string,
  { id: string; node: t.FunctionExpression }
>

interface State {
  filename: string
  opts: {
    minify: boolean
    root: string
  }
  imported: Record<string, boolean>
  refs: Set<any>
  serverIndex: number
  splitIndex: number
  splitModulesById: SplitModulesById
}

export async function compileFile(opts: {
  code: string
  compileAst: CompileAstFn
  filename: string
}) {
  return await opts.compileAst({
    code: opts.code,
    filename: opts.filename,
    getBabelConfig: () => ({
      plugins: [
        [
          {
            visitor: {
              Program: {
                enter(programPath: babel.NodePath<t.Program>, state: State) {
                  const splitUrl = `${splitPrefix}:${opts.filename}?${splitPrefix}`

                  /**
                   * If the component for the route is being imported from
                   * another file, this is to track the path to that file
                   * the path itself doesn't matter, we just need to keep
                   * track of it so that we can remove it from the imports
                   * list if it's not being used like:
                   *
                   * `import '../shared/imported'`
                   */
                  let existingCompImportPath: string | null = null
                  let existingLoaderImportPath: string | null = null

                  programPath.traverse(
                    {
                      CallExpression: (path) => {
                        if (!t.isIdentifier(path.node.callee)) {
                          return
                        }

                        if (
                          !(
                            path.node.callee.name === 'createRoute' ||
                            path.node.callee.name === 'createFileRoute'
                          )
                        ) {
                          return
                        }

                        if (t.isCallExpression(path.parentPath.node)) {
                          const options = resolveIdentifier(
                            path,
                            path.parentPath.node.arguments[0],
                          )

                          let found = false

                          const hasImportedOrDefinedIdentifier = (
                            name: string,
                          ) => {
                            return programPath.scope.hasBinding(name)
                          }

                          if (t.isObjectExpression(options)) {
                            options.properties.forEach((prop) => {
                              if (t.isObjectProperty(prop)) {
                                if (t.isIdentifier(prop.key)) {
                                  if (prop.key.name === 'component') {
                                    const value = prop.value

                                    if (t.isIdentifier(value)) {
                                      existingCompImportPath =
                                        getImportSpecifierAndPathFromLocalName(
                                          programPath,
                                          value.name,
                                        ).path

                                      removeIdentifierLiteral(path, value)
                                    }

                                    // Prepend the import statement to the program along with the importer function
                                    // Check to see if lazyRouteComponent is already imported before attempting
                                    // to import it again

                                    if (
                                      !hasImportedOrDefinedIdentifier(
                                        'lazyRouteComponent',
                                      )
                                    ) {
                                      programPath.unshiftContainer('body', [
                                        template.statement(
                                          `import { lazyRouteComponent } from '@tanstack/react-router'`,
                                        )(),
                                      ])
                                    }

                                    if (
                                      !hasImportedOrDefinedIdentifier(
                                        '$$splitComponentImporter',
                                      )
                                    ) {
                                      programPath.unshiftContainer('body', [
                                        template.statement(
                                          `const $$splitComponentImporter = () => import('${splitUrl}')`,
                                        )(),
                                      ])
                                    }

                                    prop.value = template.expression(
                                      `lazyRouteComponent($$splitComponentImporter, 'component')`,
                                    )()

                                    programPath.pushContainer('body', [
                                      template.statement(
                                        `function DummyComponent() { return null }`,
                                      )(),
                                    ])

                                    found = true
                                  } else if (prop.key.name === 'loader') {
                                    const value = prop.value

                                    if (t.isIdentifier(value)) {
                                      existingLoaderImportPath =
                                        getImportSpecifierAndPathFromLocalName(
                                          programPath,
                                          value.name,
                                        ).path

                                      removeIdentifierLiteral(path, value)
                                    }

                                    // Prepend the import statement to the program along with the importer function

                                    if (
                                      !hasImportedOrDefinedIdentifier('lazyFn')
                                    ) {
                                      programPath.unshiftContainer('body', [
                                        template.smart(
                                          `import { lazyFn } from '@tanstack/react-router'`,
                                        )() as t.Statement,
                                      ])
                                    }

                                    if (
                                      !hasImportedOrDefinedIdentifier(
                                        '$$splitLoaderImporter',
                                      )
                                    ) {
                                      programPath.unshiftContainer('body', [
                                        template.statement(
                                          `const $$splitLoaderImporter = () => import('${splitUrl}')`,
                                        )(),
                                      ])
                                    }

                                    prop.value = template.expression(
                                      `lazyFn($$splitLoaderImporter, 'loader')`,
                                    )()

                                    found = true
                                  }
                                }
                              }

                              programPath.scope.crawl()
                            })
                          }

                          if (found as boolean) {
                            programPath.pushContainer('body', [
                              template.statement(
                                `function TSR_Dummy_Component() {}`,
                              )(),
                            ])
                          }
                        }
                      },
                    },
                    state,
                  )

                  eliminateUnreferencedIdentifiers(programPath)

                  /**
                   * If the component for the route is being imported,
                   * and it's not being used, remove the import statement
                   * from the program, by checking that the import has no
                   * specifiers
                   */
                  if (
                    (existingCompImportPath as string | null) ||
                    (existingLoaderImportPath as string | null)
                  ) {
                    programPath.traverse({
                      ImportDeclaration(path) {
                        if (path.node.specifiers.length > 0) return
                        if (
                          path.node.source.value === existingCompImportPath ||
                          path.node.source.value === existingLoaderImportPath
                        ) {
                          path.remove()
                        }
                      },
                    })
                  }
                },
              },
            },
          },
          {
            root: process.cwd(),
            minify: process.env.NODE_ENV === 'production',
          },
        ],
      ].filter(Boolean),
    }),
  })
}

function getImportSpecifierAndPathFromLocalName(
  programPath: babel.NodePath<t.Program>,
  name: string,
): {
  specifier:
    | t.ImportSpecifier
    | t.ImportDefaultSpecifier
    | t.ImportNamespaceSpecifier
    | null
  path: string | null
} {
  let specifier:
    | t.ImportSpecifier
    | t.ImportDefaultSpecifier
    | t.ImportNamespaceSpecifier
    | null = null
  let path: string | null = null

  programPath.traverse({
    ImportDeclaration(importPath) {
      const found = importPath.node.specifiers.find(
        (targetSpecifier) => targetSpecifier.local.name === name,
      )
      if (found) {
        specifier = found
        path = importPath.node.source.value
      }
    },
  })

  return { specifier, path }
}

// Reusable function to get literal value or resolve variable to literal
function resolveIdentifier(path: any, node: any) {
  if (t.isIdentifier(node)) {
    const binding = path.scope.getBinding(node.name)
    if (
      binding
      // && binding.kind === 'const'
    ) {
      const declarator = binding.path.node
      if (t.isObjectExpression(declarator.init)) {
        return declarator.init
      } else if (t.isFunctionDeclaration(declarator.init)) {
        return declarator.init
      }
    }
    return undefined
  }

  return node
}

function removeIdentifierLiteral(path: any, node: any) {
  if (t.isIdentifier(node)) {
    const binding = path.scope.getBinding(node.name)
    if (binding) {
      binding.path.remove()
    }
  }
}

const splitNodeTypes = ['component', 'loader'] as const
type SplitNodeType = (typeof splitNodeTypes)[number]

export async function splitFile(opts: {
  code: string
  compileAst: CompileAstFn
  filename: string
}) {
  return await opts.compileAst({
    code: opts.code,
    filename: opts.filename,
    getBabelConfig: () => ({
      plugins: [
        [
          {
            visitor: {
              Program: {
                enter(programPath: babel.NodePath<t.Program>, state: State) {
                  const splitNodesByType: Record<
                    SplitNodeType,
                    t.Node | undefined
                  > = {
                    component: undefined,
                    loader: undefined,
                  }

                  // Find the node
                  programPath.traverse(
                    {
                      CallExpression: (path) => {
                        if (!t.isIdentifier(path.node.callee)) {
                          return
                        }

                        if (
                          !(
                            path.node.callee.name === 'createRoute' ||
                            path.node.callee.name === 'createFileRoute'
                          )
                        ) {
                          return
                        }

                        if (t.isCallExpression(path.parentPath.node)) {
                          const options = resolveIdentifier(
                            path,
                            path.parentPath.node.arguments[0],
                          )

                          if (t.isObjectExpression(options)) {
                            options.properties.forEach((prop) => {
                              if (t.isObjectProperty(prop)) {
                                splitNodeTypes.forEach((type) => {
                                  if (t.isIdentifier(prop.key)) {
                                    if (prop.key.name === type) {
                                      splitNodesByType[type] = prop.value
                                    }
                                  }
                                })
                              }
                            })

                            // Remove all of the options
                            options.properties = []
                          }
                        }
                      },
                    },
                    state,
                  )

                  splitNodeTypes.forEach((splitType) => {
                    let splitNode = splitNodesByType[splitType]

                    if (!splitNode) {
                      return
                    }

                    while (t.isIdentifier(splitNode)) {
                      const binding = programPath.scope.getBinding(
                        splitNode.name,
                      )
                      splitNode = binding?.path.node
                    }

                    // Add the node to the program
                    if (splitNode) {
                      if (t.isFunctionDeclaration(splitNode)) {
                        programPath.pushContainer(
                          'body',
                          t.variableDeclaration('const', [
                            t.variableDeclarator(
                              t.identifier(splitType),
                              t.functionExpression(
                                splitNode.id || null, // Anonymize the function expression
                                splitNode.params,
                                splitNode.body,
                                splitNode.generator,
                                splitNode.async,
                              ),
                            ),
                          ]),
                        )
                      } else if (
                        t.isFunctionExpression(splitNode) ||
                        t.isArrowFunctionExpression(splitNode)
                      ) {
                        programPath.pushContainer(
                          'body',
                          t.variableDeclaration('const', [
                            t.variableDeclarator(
                              t.identifier(splitType),
                              splitNode as any,
                            ),
                          ]),
                        )
                      } else if (
                        t.isImportSpecifier(splitNode) ||
                        t.isImportDefaultSpecifier(splitNode)
                      ) {
                        programPath.pushContainer(
                          'body',
                          t.variableDeclaration('const', [
                            t.variableDeclarator(
                              t.identifier(splitType),
                              splitNode.local,
                            ),
                          ]),
                        )
                      } else {
                        console.info(splitNode)
                        throw new Error(
                          `Unexpected splitNode type ☝️: ${splitNode.type}`,
                        )
                      }
                    }

                    // If the splitNode exists at the top of the program
                    // then we need to remove that copy
                    programPath.node.body = programPath.node.body.filter(
                      (node) => {
                        return node !== splitNode
                      },
                    )

                    // Export the node
                    programPath.pushContainer('body', [
                      t.exportNamedDeclaration(null, [
                        t.exportSpecifier(
                          t.identifier(splitType),
                          t.identifier(splitType),
                        ),
                      ]),
                    ])
                  })

                  // convert exports to imports from the original file
                  programPath.traverse({
                    ExportNamedDeclaration(path) {
                      // e.g. export const x = 1 or export { x }
                      // becomes
                      // import { x } from '${opts.id}'

                      if (path.node.declaration) {
                        if (t.isVariableDeclaration(path.node.declaration)) {
                          path.replaceWith(
                            t.importDeclaration(
                              path.node.declaration.declarations.map((decl) =>
                                t.importSpecifier(
                                  t.identifier((decl.id as any).name),
                                  t.identifier((decl.id as any).name),
                                ),
                              ),
                              t.stringLiteral(
                                opts.filename.split(
                                  `?${splitPrefix}`,
                                )[0] as string,
                              ),
                            ),
                          )
                        }
                      }
                    },
                  })

                  eliminateUnreferencedIdentifiers(programPath)
                },
              },
            },
          },
          {
            root: process.cwd(),
            minify: process.env.NODE_ENV === 'production',
          },
        ],
      ].filter(Boolean),
    }),
  })
}