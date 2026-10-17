# What an AI assistant can ask FreazyKam to do

These are the MCP tools a connected assistant sees. You don't call them yourself: ask in
plain words, and the assistant picks them. Knowing the list helps you ask for things it can
actually do.

Everything marked **undo** is one ordinary step in the project's history.

## Look

| Tool | Does |
|---|---|
| `get_status` | Is a tab connected, and a summary of its project, stock and units |
| `list_paths` | Every path: name, shape, size, open or closed, tabs |
| `get_shape` | A shape's settings (a gear's teeth, a box's size, …) |
| `list_toolpaths` / `get_toolpath` | The toolpaths in cut order, their settings and what they cut |
| `list_tools` | Your tool library, or an imported catalogue |
| `toolpath_defaults` | What each toolpath type would use if told nothing |
| `list_shape_types` | Every shape it can draw, and its settings |
| `list_corners` | The corners of a path that can be rounded or relieved |

## Draw and change — undo

| Tool | Does |
|---|---|
| `add_shape` | Any shape from the Draw tab: rectangle, circle, text, gear, box, clock parts, … |
| `update_shape` | Change a shape's settings, as the Properties panel does. Its toolpaths follow |
| `transform_paths` | Move, rotate, scale or mirror |
| `group_paths` / `ungroup_paths` | Group and ungroup, as Ctrl+G does |
| `delete_paths` | Delete, with any toolpath that cut only those paths |
| `set_stock` | Stock size and material |
| `undo` / `redo` | The same undo you use |

## Path tools — undo

| Tool | Does |
|---|---|
| `offset_paths` | Offset in or out |
| `boolean_paths` | Union, subtract, intersect. The originals are hidden, not deleted |
| `pattern_paths` | Linear or circular copies |
| `text_along_path` | Lay text round a circle or along a curve |
| `corner_treatment` | Round, chamfer or dogbone corners |
| `nest_paths` | Pack parts onto the stock |
| `trace_image` | Turn a picture into outlines |

## Toolpaths — undo

| Tool | Does |
|---|---|
| `create_toolpath` | Profile, pocket, V-carve, drill, trochoidal, surface, photo V-carve, 3D profile, inlay |
| `update_toolpath` | Change a toolpath's settings (and the rest of the toolpaths made with it, as its form does) |
| `regenerate` | Regenerate toolpaths and report how each came out |
| `reorder_toolpaths` | Change the cut order |
| `set_toolpath_visible` | Show or hide (a hidden toolpath is left out of the G-code) |
| `delete_toolpaths` | Delete |
| `add_tabs` / `delete_tabs` | Holding tabs on a path |

## Files and the job

| Tool | Does |
|---|---|
| `export_check` | The check Export G-code runs: tools, depths, extents, run time, warnings |
| `get_gcode` | Read the G-code, a page at a time |
| `export_gcode` | Write the G-code to a file on your computer |
| `import_file` / `import_image` | Bring in an SVG, DXF or picture from your computer |
| `save_project` | Save a copy of the project to a file |
| `open_project` / `new_project` | Replace the open project — **asks you first** if it has unsaved changes. Not undoable |

## Your tool library — not undone

| Tool | Does |
|---|---|
| `add_tool` | Add a bit you own to **My Tools** |
| `update_tool` | Change one of **My Tools** (catalogue tools are left alone). Toolpaths using it regenerate |

These change your library, which outlives the project, so **undo can't reverse them**. Change
a tool back in the **Tool Library** tab.

## Files on your computer

The assistant gives a **full path** to any file it reads or writes. It won't replace an
existing file unless you've told it to.

**Related:** [Connect an AI assistant](../how-to/connect-an-ai-assistant.md) ·
[What an assistant can and can't do](../explanation/ai-assistants.md)
