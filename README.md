# `electron`

- use https://unjs.io/packages/ohash for hashing
- use https://unjs.io/packages/c12 for configs
- use https://unjs.io/packages/citty for cli building
- use https://unjs.io/packages/magicast for programmatic code modification/generation
- use https://unplugin.unjs.io/guide/ for custom internal plugins
- use https://starlight.astro.build for docs
- use https://nextjs.org/ for landing
- use https://ui.shadcn.com/ for custom components that can be used only on electron (custom shadcn registry of components)
- use https://reactrouter.com/ for pages routing


## Main Offering
- IPC simplification
    - file based (`*.{main,renderer}.ipc.{ts,js}`)
    - type-safety
    - supporting additional types via https://github.com/flightcontrolhq/superjson
    - bi-directional (main => renderer is broadcast)
    - channel collision avoidance
- FileSystem based routing (typed routes)
- Custom shadcn components
- HMR (renderer only)
- Simplified Build pipeline via https://www.electron.build/
- Bootstraping
    - Icons and metadata generation and management
    - Platform specific hacks and workarounds (configurable via config file)
- Project scaffolder - `create-electron`
- CLI (inspired from https://starlight.astro.build)
- State Sync - similar to electron-mobx, zustron, electron-redux
- cool abstractions
    - Context Menu - https://github.com/sindresorhus/electron-context-menu
    - MenuBar/Tray - https://github.com/max-mapper/menubar
    - Spotlight - https://github.com/robiXxu/spotlight-electron, https://github.com/CharlieHess/electron-spotlight
    - DB - built in drizzle and migrations support
- automatic protocol and deeplinks
- logging and analytics via open telemetry

## Optional Offering (not main priority)
- IPC Simplification
    - unicast and multicast support for main => renderer ipc calls
    - scope (directive) based ipc (`use electron` and `use renderer`)
- colocation of renderer and electron code
- JSX based electron primitives
```jsx
import {BrowserWindow, WebContents} from "electron"

export default async function Main() {
    return (
        <BrowserWindow onClose={()=>{
            console.log("Window Closed")
        }}>
            <WebContents contextIsolation sandbox>
                <h1>
                    Hello World
                </h1>
            </WebContents>
        </BrowserWindow>
    )
}
```
- sync engine similar to https://pglite.dev/docs/sync, https://zero.rocicorp.dev/
- easy electron utility process spawning and management