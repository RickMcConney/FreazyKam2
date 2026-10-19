# Third-Party Notices

FreazyKam includes code ported or adapted from the projects below. Those portions
remain under their original licenses, reproduced here as those licenses require.
They are not covered by the FreazyKam license in `LICENSE.md`.

---

## FreeCAD Adaptive2d

- Source: https://github.com/FreeCAD/FreeCAD (`src/Mod/CAM/libarea/Adaptive.cpp`)
- Used in: `src/cam/adaptiveFC/` (the Adaptive pocket strategy)
- License: GNU Lesser General Public License v2.1 or later. Full text in
  `LICENSES/LGPL-2.1.txt`.

```
Copyright (c) 2018 Kresimir Tusek <kresimir.tusek@gmail.com>

This library is free software; you can redistribute it and/or
modify it under the terms of the GNU Library General Public
License as published by the Free Software Foundation; either
version 2 of the License, or (at your option) any later version.

This library is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU Library General Public License for more details.
```

The FreazyKam port in `src/cam/adaptiveFC/` is likewise licensed under the
LGPL-2.1-or-later.

---

## WoodCAM

- Source: https://github.com/danielma89/WoodCam
- Used in: the 3D Profile waterline finishing strategy, common-line cut planning
  (`src/cam/commonLine.ts`) and nesting
- License: MIT (as declared in the project's `package.xml`)

```
MIT License

Copyright (c) Daniel Moura

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## CNC GCode Tools

- Source: https://github.com/jeyeager65/cnc-gcode-tools
- Used in: the 3D simulator's cutter models (`src/three/toolMesh.ts`) and the
  stock-simulation header written into G-code (`src/cam/gcode.ts`)
- License: MIT

```
MIT License

Copyright (c) 2025 CNC GCode Viewer Contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
