# Herdr Studio

A personal layout for the [Herdr](https://herdr.dev) desktop app, set up as a cockpit for working with
coding agents: a sidebar with spaces and an agent dashboard, a Home panel that says what needs you now,
alerts for merge requests and pipelines, and side panes for tasks, messages, merge requests, ports,
usage and diff review. Two panes can show at once, one above the other.

It is made of one layout (`layouts/studio.json`) and a set of mods (`mods/studio-*`), all written
for Herdr's native UI toolkit. A small script, `dev.py`, checks them and copies them into Herdr's
config folder.

## What you get

| Where | What it does |
| --- | --- |
| Sidebar, top | **Spaces**: coloured avatars, a status badge per space (needs you, working, done), the repo's branch when it is unusual, `Ctrl+1` to `Ctrl+9` hints. |
| Sidebar, bottom | **Agents**: counts by status that double as filters, sections in order of urgency, each agent's title, time in state, address and branch. |
| Tab bar | Tabs with `Cmd+1` to `Cmd+9` hints, **+** and **Neovim**, then two groups of panel buttons: what needs you (**Home**, **Inbox**, **MRs**, **Tasks**) and tools (**Agent talk**, **Monitoring**, **Ports**), then a **Panels** menu for the rest. Counters on Inbox, MRs (red when one of your pipelines failed), Tasks and Ports. Click a button to open its pane at the top; right-click opens it in the lower half (a short line under the icon marks it). |
| Pane header | Program, folder, branch and the terminal's Herdr address. |
| Status bar | Machine, address, folder, branch; then chips that appear only when they matter: agents that need you, failed pipelines, Herdr errors, an automation due within the hour, quiet mode, Claude's 5-hour limit (amber past 70%, red past 90%), CPU and memory. Each opens the pane behind it. |
| Dock icon | A badge with the agents that need you plus your failed pipelines. |
| Side pane: **Home** | The default pane. Herdr errors, agents that are stuck or finished, MRs waiting for your review, your MRs that are failing, in conflict or running, the tasks you are doing (each with its Jira key, space, agent and MR), your Claude and Codex limits with the next automation, and what you shipped since the last workday or this week, with **Copy standup** (Done, Doing, Blockers as Markdown). The bell turns alerts off (quiet mode). |
| Side pane: **Inbox** | Agents that need you or just finished, with the end of their screen and a reply box. **Other agents** (folded) lists the rest, so you can message any agent from here. |
| Side pane: **Tasks** | A to-do list with Markdown details and links. A task with a Jira key in its title or a Jira link becomes a work item: chips for the Jira card, the space on that branch and the MR with its pipeline. "Send to agent" writes the task as a brief file and sends the agent a one-line pointer. You set the order within a group: drag a card by its header, or `J`/`K`; a task that changes status goes to the top of its new group. Done tasks move to an archive file after a week, or at once with **Archive now**. |
| Side pane: **MRs** | Your open GitLab merge requests and ones waiting for your review, with pipeline state, Retry, Open and Copy link. |
| Side pane: **Projects** | Your project folders. Click one to go to its space; **Start** (or `s`) makes a new space with Agent (Claude), Edit (Neovim) and Runner (a shell) tabs. |
| Side pane: **Monitoring** | Context fullness per agent session, 5-hour and weekly limits for Claude and Codex, and CPU and memory per space and pane. |
| Side pane: **Ports** | Dev servers listening on a port, with their folder and space. Open, copy the URL, or stop one. |
| Side pane: **Review** | Opens [Hunk](https://www.hunk.dev/) on the repo you are in, and lists open Hunk windows. |
| Side pane: **Agent talk** | Which agents message which. |
| Side pane: **Automations** | Your crontab's jobs: add, edit, turn on and off. |

### Keyboard in panels and the sidebar

Every side panel and both sidebar lists work like a vim buffer once they have the keyboard. They get it
from `Ctrl+B p …`, `Cmd+Shift+H`, `Cmd+I` and `Cmd+G` (open and focus), `Ctrl+B P …` (lower half), or by
moving onto them from a pane with `Ctrl+B h`/`l`, or by clicking anywhere in them. While a panel has the keyboard its title turns accent
and a footer lists its keys; `?` shows them all. The shared rules live in `nav.js`, one copy per mod.

| Key | Everywhere |
| --- | --- |
| `j` `k` (`5j`), `gg` `G` (`3G`), `Ctrl+D` `Ctrl+U` | Move, jump, half a page |
| `Ctrl+H` `Ctrl+J` `Ctrl+K` `Ctrl+L` | To the pane, panel or list on that side (tmux-navigator style) |
| `h`, `Esc` | Back to the terminal |
| `q` | Close the panel (only its half when it's the lower one) |
| `Enter`, `o`, `l` | Open the row |
| `yy`, `dd`, `r` | Copy its link, delete (stop, close), refresh |

| Panel | Its own keys |
| --- | --- |
| Home | `p` peek agent, `c` copy standup, `w` day or week, `m` quiet, `i` `t` Inbox, Tasks |
| Inbox | `i`/`a` reply (`Esc` back to the list), `f` go to agent, `p` peek, `O` other agents |
| MRs | `R` retry pipeline, `f` filters, `D` hide drafts |
| Tasks | `x`/`Space` next status, `J`/`K` move down, up, `a`/`o` quick add, `e` edit, `s` send to agent, `f` filter, `D` done, `A` archive done |
| Ports | `s` go to space, `H` hidden listeners |
| Monitoring | `[` `]` machine |
| Review | `t` beside or new tab |
| Automations | `a` new, `e` edit, `t`/`Space` on or off, `f` filter |
| Agent talk | `c` clear |
| Spaces | `za` terminals, `r` rename, `n` new space, `dd` close (asks) |
| Agents | `p` peek, `P` pin, `f` filter, `s` space or all |
| Projects | `/` or a click jumps into the filter field at the top (fuzzy on name and path; `Enter` back to the list, `Esc` clears, `↓ ↑ Ctrl+N/P` move while typing), `s` start, `a` add, `x` remove (asks), `dd` remove |
| Quick switcher | `Ctrl+J`/`Ctrl+N` down, `Ctrl+K`/`Ctrl+P` up |

### Alerts

The tab bar polls GitLab every 3 minutes, also while Herdr is in the background, and tells you when one
of your pipelines fails or passes, an MR of yours is approved or gets comments, or someone asks for your
review. In Herdr it is a toast (click it for the MRs pane); with the window in the background it is also
a macOS notification, and a failed pipeline plays Herdr's "needs you" sound. The first poll after a
start only sets the baseline, so nothing old is announced. Quiet mode (`Ctrl+B q` or the bell on Home)
keeps only the Dock badge. Agents that need you are left to Herdr's own alerts.

### Keys

`Cmd+P` opens the quick switcher: spaces, tabs, agents and addresses, and typing a panel's name
("inb", "ports") offers to open it. `Ctrl+B` opens the leader; the next key runs a command or opens a
group, and `?` lists every shortcut. Pressing `Ctrl+B` twice sends a real `Ctrl+B` to the terminal.

| Key | Does |
| --- | --- |
| `Cmd+B` | Sidebar: fold to the rail, or unfold (the rail's » does the same) |
| `Cmd+Shift+H` | Home panel, open and focus |
| `Cmd+I` | Inbox panel, open and focus |
| `Cmd+G` | Review panel, open and focus |
| `Cmd+Shift+J` | Go to the agent that has needed you longest |
| `Cmd+Shift+E` | Side panel, show or hide |
| `Cmd+A` | Select all in the terminal |

| Leader | Does |
| --- | --- |
| `h j k l`, `H J K L` | Focus or swap panes |
| `w`, `t`, `s`, `a` | Pane, tab, space and agent groups |
| `p` then `h i t g o m l p c r` | Home, Inbox, Tasks, MRs, Ports, Monitoring, Agent talk, Projects, Automations, Review: open and focus (`q` inside closes) |
| `P` then `P`, or `h i g o m` | Toggle the lower half, or open that pane in it |
| `g n` | Go to the agent that has needed you longest |
| `g d` | Go to the agent that finished last |
| `g m` | Open the MR for the branch of the pane you are in |
| `g t` | New task (Tasks, with the quick-add field ready) |
| `q` | Quiet mode on or off |
| `n` | Neovim tab |
| `b`, `B` | Sidebar: rail or full; hide or show it |
| `e` | Side panel, show or hide |
| `f f`, `f p` | Quick switcher, command palette |

## Requirements

- **Herdr** (the desktop app) with its `herdr-app` command on your `PATH`. Run `herdr-app status` to check.
- **Python 3** to run `dev.py`.
- **macOS.** Ports uses `lsof` and `ps`; the rest is portable, but it has only been tried on macOS.

Optional, each for one pane:

| Tool | Needed for |
| --- | --- |
| `glab` ([GitLab CLI](https://gitlab.com/gitlab-org/cli)), signed in with `glab auth login` | the **MRs** pane and its counter |
| `hunk` ([hunk.dev](https://www.hunk.dev/)) | the **Review** pane |
| `nvim` | the **Neovim** button and Projects' Edit tab |
| `claude` | Projects' Agent tab |
| `git` | **Review**, spaces' branch labels, repo-root detection |
| Claude Code with a status line that prints `Context … Usage … Weekly …`, and/or Codex | numbers in the **Usage** pane |

A pane whose tool is missing shows a short message instead of data. Nothing else breaks.

## Install

```sh
git clone git@github.com:trihargianto/herdr-studio.git
cd herdr-studio
python3 dev.py
```

`dev.py`:
1. runs `herdr-app check` on every mod that changed, and refuses to publish one that fails;
2. copies `layouts/` and `mods/` into `~/.config/herdr-app/`;
3. switches Herdr to the `studio` layout;
4. keeps watching the folder and republishes whenever you save a file.

Leave it running while you edit. Press `Ctrl-C` to stop watching: the layout stays installed.
To publish once and exit, run `python3 dev.py --once`.

`dev.py` only touches the files it records in `.published.json`. It will not overwrite a file in
Herdr's config folder that it did not put there, and it stops with a message if one is in the way.

## Configure

Most of it works as soon as it is installed. These are the places to adjust things.

**Layout.** `layouts/studio.json`: sidebar width (`sidebar`, 232 px), tab bar and title bar height
(44 px), pane gaps and corner radius, and the side panel's width (`panel`, 320 px). The side panes
are the children of the `panel-body` stack. The lower half is the `panel-lower` stack, hidden until
you open a pane there; its blocks are second copies of five read-only panes (Home, Inbox, MRs, Ports, Monitoring), with
`"props": { "slot": "lower" }`. Tasks is left out: two copies would save over each other.

**Jira.** Work items link to `https://mamikos.atlassian.net/browse/<KEY>`; change `JIRA` in
`mods/studio-home/work.js` and its copy in `mods/studio-tasks/work.js`. Keys are upper case
(`CFE-1880`), in a task's title, a Jira link, or a branch name.

**Colours and fonts.** These come from your Herdr theme (Settings in Herdr, or `settings.json`). The
mods only use theme colours, so a different theme changes everything.

**Key hints.** The `Cmd+1` and `Ctrl+1` hints are read from your `keys.json`, so they match your
real bindings.

**Where things are saved.**

| What | Where |
| --- | --- |
| Tasks | `~/.config/herdr-app/studio-tasks/tasks.json` |
| Archived tasks | `~/.config/herdr-app/studio-tasks/tasks-archive.json` |
| Briefs sent to agents | `~/.config/herdr-app/studio-tasks/briefs/` |
| Small per-pane settings (Space or All, folded sections, where Hunk opens) | each pane's own local storage, inside Herdr |

**Polling.** Side panes refresh only while they are the pane shown, and only while the Herdr window
is in front. The tab bar runs the rest, in `mods/studio-tabs/feed.js`, and shares what it finds with
the other mods (`studio.mrs`, `studio.limits`, `studio.next`, `studio.errors`): merge requests every
3 minutes (also in the background, for alerts), limits every minute (two `hc read`s), the crontab every
5 minutes and `herdr-app status` every minute. Ports are counted every 15 s and tasks every 5 s. The
intervals are constants at the top of `feed.js` and in the tab bar's `init`.

## How the panes find your repo

A pane looks at the terminal you last focused and uses the folder that terminal's pane reports
(`panes()` in Herdr's API), which follows `cd`. It then asks git for the repository root. Herdr's
terminal list and a space's stored folder only record where something started, so they are not used.

## Layout of this repository

| Path | What it is |
| --- | --- |
| `layouts/studio.json` | Window structure, sizes, pane frames, the side panel's two stacks |
| `layouts/studio.svg` | The preview Herdr's settings screen shows |
| `mods/studio-tabs` | Tab bar, panel buttons, counters, Neovim button, and the feed (`feed.js`, `feedlib.js`) |
| `mods/studio-home` | Home pane; `work.js` joins a task to its Jira card, branch, agent and MR |
| `mods/studio-spaces`, `studio-dashboard` | Sidebar: spaces list and agents panel |
| `mods/studio-pane` | Pane headers |
| `mods/studio-workspace-chrome`, `studio-workspace-status` | Sidebar top row and footer; status bar |
| `mods/studio-leader`, `studio-picker`, `studio-panel-menu` | `Ctrl+B` leader, `Cmd+P` switcher, the Panels menu |
| `mods/studio-inbox`, `studio-tasks`, `studio-mrs`, `studio-projects`, `studio-usage`, `studio-ports`, `studio-review`, `studio-talk`, `studio-automations` | The other side panes |
| `mods/agenttrail` | The Agenttrail Map. Not used by the layout; Agent talk borrows its look. |
| `tests/` | `node --test tests/feedlib.test.mjs` (feed and work-item helpers), `python3 -m unittest tests/test_automations.py` |
| `dev.py` | Checks and publishes to Herdr, and watches for edits |
| `AGENTS.md`, `DESIGN.md` | Notes for coding agents and the design rules used here |

Herdr writes `gpui-kit.d.ts` and `jsconfig.json` into every mod folder so editors can complete the
API. They are generated, so they are not in git.

## Develop

1. Edit a mod or the layout in this folder, never in `~/.config/herdr-app/`.
2. With `dev.py` running, a save is checked and published within a second or two. A mod that fails
   `herdr-app check` is not published, and the reason is printed.
3. `herdr-app status` shows errors from files and mods. `herdr-app shot file.png` saves a screenshot
   of the window, which helps when adjusting spacing.

Note that `herdr-app check` renders only a mod's first, empty state. A mod can pass it and still
fail once real data arrives, so open the pane in Herdr after changing it.

## Switch back or uninstall

Return to Herdr's own layout at any time:

```sh
herdr-app do layout.switch '{"name":"main"}'
```

To remove Studio completely, stop `dev.py`, then delete the files listed in `.published.json` from
`~/.config/herdr-app/` (the `studio` layout and the `studio-*` mod folders). Your tasks stay in
`~/.config/herdr-app/studio-tasks/` unless you delete that too.

## Back up

The whole theme is this repository. Your tasks live outside it, in
`~/.config/herdr-app/studio-tasks/`, so copy that folder separately if you want them kept.

## Credits and licence

Several mods (spaces, tabs, pane header, chrome, status bar) began as copies of Herdr's shipped mods
and were reworked, so they carry Herdr's design. No licence is set for this repository yet.
