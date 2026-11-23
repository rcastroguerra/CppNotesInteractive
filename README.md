# CppNotesInteractive

A Visual Studio Code extension for working with `.cppnotes` files: a document made of an ordered list of **panels** that can be **text** (rich-format notes) or **code** (C or C++). Each code panel compiles and runs (notebook style), showing the **output below the panel**, either **individually** or **all at once**. Programs that read input (`std::cin` / `scanf`) receive it from a **console** that appears in the panel only while it runs.

## Features

- **Custom Editor** for `*.cppnotes` with a web UI:
  - **+ Add text** and **+ Add code** buttons in the top bar (append at the end), plus **buttons below each panel** that insert right after that panel (notebook style).
  - Each panel: **C / C++** language selector (code panels), **▶ Run**, **↑ ↓** (reorder) and **Delete**.
  - **Drag to reorder**: grab the **⠿** handle in the header and drag the panel up or down.
  - **▶ Run all** compiles and runs every code block in order.
  - **■ Stop** cancels the current run (kills the process and aborts the remaining blocks).
  - **Save** + autosave while typing (Ctrl+S saves to disk).
- **C and C++ code with colors**: code editor with **syntax highlighting** (comments, strings, numbers, types, functions, `#include`/`#define`…) and **auto-growing height** (grows with the lines), plus **auto-indentation** on Enter (respects the current indentation and adjusts a level on `{` / `}`). C++ panels include a **+std** button that inserts `using namespace std;` so you can write without `std::` (the new template already includes it).
- **Rich text editor** in text panels: paragraph, headings, **size in px**, **quote/block**, **color** (palette + custom picker), **highlight + remove highlight**, lists (bullets/numbered), bold, italic, underline, **alignment/justify**, **indent** and clear formatting, with **keyboard shortcuts**.
- **Output below the panel**: code is compiled (as UTF-8) and the binary runs as a child process, streaming its output below the panel in real time. The **input console** (for `cin`/`scanf`) appears only while the program runs.
- Compilation errors are shown below each panel.

## `.cppnotes` file format

It is JSON with an ordered list of panels:

```json
{
  "panels": [
    { "id": "text_1", "type": "text", "text": "Plain notes..." },
    { "id": "code_1", "type": "code", "language": "cpp", "code": "#include <iostream>\n..." },
    { "id": "code_2", "type": "code", "language": "c", "code": "#include <stdio.h>\n..." }
  ]
}
```

- `type: "text"` → notes panel (field `text`, which contains **HTML** with the rich formatting).
- `type: "code"` → code panel (fields `code` and `language`, which is `"cpp"` or `"c"`).

There is an example with text, C++ and C panels in `examples/ejemplo.cppnotes`.

> The old `{ "notes": "...", "codeBlocks": [...] }` format is also accepted and migrated to panels automatically on open.

## Requirements

- Node.js and npm.
- C/C++ compilers on the PATH:
  - **Windows**: install [MinGW-w64](https://www.mingw-w64.org/) or [winlibs](https://winlibs.com/) and add its `bin` folder to the PATH (includes `gcc.exe` and `g++.exe`), or configure absolute paths in the settings.
  - **Linux/macOS**: `sudo apt install gcc g++` / `xcode-select --install` (clang).

## Compile

```bash
npm install
npm run compile
```

This runs `tsc` and produces `out/extension.js`.

## Test (F5)

1. Open this folder in VS Code (`File > Open Folder...`).
2. Press **F5**. An "Extension Development Host" window opens.
3. Open or create a `.cppnotes` file (e.g. copy `examples/ejemplo.cppnotes`).
4. Add text/code panels, choose C or C++, and press **▶ Run** (one panel) or **▶ Run all**.

## Build the extension (.vsix)

```bash
npm install -g @vscode/vsce
vsce package
```

This creates `cppnotesinteractive-0.2.0.vsix`. Install it with:

```bash
code --install-extension cppnotesinteractive-0.2.0.vsix
```

Or in VS Code: Extensions view → `...` menu → **Install from VSIX...**.

## Configuration

Settings (`Ctrl+Shift+P` → "Preferences: Open Settings (UI)" → search "CppNotes"):

- `cppnotes.cCompiler` — C compiler (default `gcc`).
- `cppnotes.cppCompiler` — C++ compiler (default `g++`).
- `cppnotes.cFlags` — C flags (default `-std=c11 -O2`).
- `cppnotes.cppFlags` — C++ flags (default `-std=c++17 -O2`).

On Windows you can set an absolute path, e.g. `C:\mingw64\bin\g++.exe`.

## How the execution works

- **Single panel**: on **▶ Run**, the code is written to a temporary `.c`/`.cpp`, compiled with `gcc`/`g++` (UTF-8), and the binary runs as a child process, streaming its output below the panel in real time.
- **Run all**: compiles and runs each code panel **in sequence**, showing the output below each one.
- **Standard input** (`scanf` / `std::cin`) is typed in the panel's **console** (it appears only while the program runs): each line + **Enter** is sent to the process.

> Execution uses `child_process.spawn` (captures stdout/stderr) and `exec` (compilation); it never uses the Output panel or the Integrated Terminal.

## Notes and limitations

- **Line-based input**: input is sent **line by line** from the panel console. Ideal for `scanf`/`std::cin`/`fgets`/`getline`. Character-by-character input (e.g. `getchar()` without newline) may need Enter per character.
- **Encoding**: compilation and output are **UTF-8**, so accents (ñ, ú, etc.) display correctly.
- **Stop**: the **■ Stop** button kills the running processes.
- **Saving**: there is no public `document.save()` method; the **Save** button uses `workbench.action.files.save`. With `files.autoSave` enabled it also saves automatically.
- **Compilers off the PATH**: configure `cppnotes.cCompiler` / `cppnotes.cppCompiler` with full paths.
- Temporary binaries stay in `os.tmpdir()` (`%TEMP%` on Windows).

## Project structure

```
CppNotesInteractive/
├─ package.json
├─ tsconfig.json
├─ src/
│  └─ extension.ts        # all the logic (custom editor + compile + run)
├─ examples/
│  └─ ejemplo.cppnotes
├─ .vscode/
│  ├─ launch.json          # F5 configuration
│  └─ tasks.json           # build task
└─ README.md
```

## Dependencies

No `vscode` package is installed from npm: the **VS Code API** is provided by VS Code itself at runtime. `package.json` only contains dev dependencies: `@types/vscode`, `@types/node` and `typescript`.
