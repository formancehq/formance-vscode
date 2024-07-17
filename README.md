# numscript-prototype-vscode

Vscode extension for the new numscript LSP prototype

### Features

- Hover on variable to see its type
- LSP diagnostics for errors and warnings (you can see the full list [here](https://github.com/ascandone/numscript-prototype/blob/main/analysis/diagnostic_kind.go))
  - for example, invalid allotment sum, wrong type for variables, bad usage of `remaining` keyword, unbound variables, warnings for unused variables
- GOTO variable definition
- Fault tolerant parser: even when in a parsing error state, the static analysis is still able to perform checks on the rest of the AST
