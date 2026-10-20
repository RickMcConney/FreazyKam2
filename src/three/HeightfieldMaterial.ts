import * as THREE from 'three'
import { segTool, type SimSegment, type ToolState } from '../sim/gcodeParser'
import { Heightfield, gridForSegments, computeCutBounds } from '../sim/heightfield'
import type { UnderProgram } from '../sim/otherSide'
import type { ZOrigin } from '../store/workpieceStore'
import { Z_DATUM_COLOR_THREE } from '../colors'
import { DEFAULT_TILE_MM } from './woodTexture'

// ─── Heightfield material-removal simulation ──────────────────────────────────
//
// The stock is a single regular grid of
// height samples (`topZ`, one per vertex). A static displaced plane reads those
// heights from a float DataTexture in the vertex shader; surface normals are
// computed per-vertex from neighbouring texels so shading stays smooth at any
// resolution. Cutting just lowers `topZ` cells under the tool footprint and the
// dirty texture is re-uploaded — no geometry is ever rebuilt.
//
// The per-cell carve math (flat / ball / V-bit) is a closest-point model
// evaluated over the uniform grid.
// Coordinate convention matches ThreeView: workpiece bottom at three-space Y=0,
// top at Y=thickness; threeZ = -cncY. `topZ` holds material height above the
// bottom (0 … thickness).

// THE BOARD IS TWO HEIGHTS PER COLUMN on a double-sided job (sim/otherSide.ts): this side's
// surface `h` coming down (uHeight) and the other side's coming up from the bottom,
// `b = T − u` where `u` is the other side's own carve (uUnder). Material is wherever h > b.
// Every mesh below reads both through these, so a column cut from both sides until they
// meet is a hole, and the walls of the two sides' cuts meet where they touch. With no other
// side (uShowUnder = 0) b is 0 and all of it is the single-sided board it always was.
//
// Drawn heights: the top surface at max(h, b) and the bottom at b, so in a hole both sit
// at the same height and the walls on either side run continuously from the top face to
// the bottom one. A HOLE vertex is h − b ≤ 0.001; a fragment is dropped where all three of
// its triangle's vertices are holes (the interpolated flag reaches 1).
const TWO_SIDED_GLSL = /* glsl */ `
  uniform sampler2D uUnder;
  uniform float uShowUnder;
  uniform float uThicknessU;
  float _bottomAt(vec2 uv) { return uShowUnder > 0.5 ? uThicknessU - texture2D(uUnder, uv).r : 0.0; }
  float _topAt(vec2 uv) { return max(texture2D(uHeight, uv).r, _bottomAt(uv)); }
  float _holeAt(vec2 uv) { return texture2D(uHeight, uv).r - _bottomAt(uv) <= 0.001 ? 1.0 : 0.0; }`

/** The uniforms TWO_SIDED_GLSL reads, shared by every mesh so one toggle reaches all. */
interface UnderUniforms {
  uUnder: { value: THREE.Texture }
  uShowUnder: { value: number }
  uThicknessU: { value: number }
}

function isCuttingSeg(seg: SimSegment): boolean {
  return !seg.rapid && (seg.prevZ < 0 || seg.z < 0)
}

// RAPIDS ARE CARVED, and the surface one leaves is tinted this red. Every G0 below the
// stock top goes through the same carve as a cut, at this view's own resolution — a rapid
// that touches nothing changes nothing, so a stay-down link over cleared floor costs a
// carve and no colour. A sample is marked as a rapid lowers it, and cleared again wherever
// a later cut reaches that surface, so red that survives to the finished part is damage the
// part keeps, and red that fades during playback was stock the program was about to clear.
const DAMAGE_RGB: [number, number, number] = [0.86, 0.12, 0.1]
// The mark, in a byte texture the shader reads normalised (255 → 1.0).
const DAMAGED = 255

// Paint left in the cuts after the face is sanded back. Not quite black: a groove
// full of paint still catches a little light off its walls, and a dead 0 reads as a
// hole in the mesh rather than a filled line. Sampled in the same space as the wood
// texture's raw texels (see the gamma lift below), so it is a value tuned by eye
// against the wood, not a colorimetric one.
const PAINT_RGB: [number, number, number] = [0.035, 0.032, 0.03]

// The surface uses a stock MeshLambertMaterial so it lights like the rest of the
// scene. onBeforeCompile injects the heightfield
// displacement and per-vertex normals, and samples the planar world-mm-mapped
// wood texture for the diffuse colour — carved surfaces read as wood too,
// distinguished by depth and lighting rather than a highlight colour.
//
// `paintedCuts` swaps that for the opposite finish: cuts DARK against bare wood.
// It is how a photo v-carve is actually finished — flood the board with paint, then
// sand the face back so paint survives only in the grooves — and it is the only way
// to see whether the carve reads as a picture, since the image lives entirely in how
// wide each groove is. Whole-surface rather than per-operation because that is what
// the finish does: paint fills every cut on the board, and sanding only reaches the
// uncut top face.
function patchSurfaceShader(
  mat: THREE.MeshLambertMaterial,
  texture: THREE.DataTexture,
  NX: number, NY: number,
  sx: number, sy: number,
  T: number,
  woodTex: THREE.Texture,
  tileMM: [number, number],
  paintedCuts: boolean,
  damage: THREE.DataTexture | null,
  under: UnderUniforms,
) {
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, under)
    shader.uniforms.uHeight = { value: texture }
    shader.uniforms.uDamage = { value: damage ?? texture }
    shader.uniforms.uHasDamage = { value: damage ? 1 : 0 }
    shader.uniforms.uDamageRgb = { value: new THREE.Color(...DAMAGE_RGB) }
    shader.uniforms.uTexel = { value: new THREE.Vector2(1 / NX, 1 / NY) }
    shader.uniforms.uSpacing = { value: new THREE.Vector2(sx, sy) }
    shader.uniforms.uWoodTex = { value: woodTex }
    shader.uniforms.uWoodScale = { value: new THREE.Vector2(1 / tileMM[0], 1 / tileMM[1]) }
    shader.uniforms.uThickness = { value: T }
    shader.uniforms.uPainted = { value: paintedCuts ? 1 : 0 }
    shader.uniforms.uPaint = { value: new THREE.Color(...PAINT_RGB) }

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', /* glsl */ `#include <common>
        uniform sampler2D uHeight;
        uniform vec2 uTexel;     // 1/NX, 1/NY
        uniform vec2 uSpacing;   // sample spacing in world mm (sx, sy)
        attribute vec2 aHUv;     // texel-centre UV for this vertex
        uniform sampler2D uDamage;
        uniform float uHasDamage;
        varying float vDamage;   // 1 where a rapid left the surface (interpolated: soft edge)
        varying float vH;
        varying float vHole;
        varying vec2 vWUv;       // planar wood UV in mm: (localX, localY)
        ${TWO_SIDED_GLSL}`)
      // Per-vertex normal from neighbouring texels (smooth shading at any res).
      // Tangents in three-space: +u → +X, +v(row) → +cncY → -threeZ.
      .replace('#include <beginnormal_vertex>', /* glsl */ `
        float _hL = _topAt(aHUv - vec2(uTexel.x, 0.0));
        float _hR = _topAt(aHUv + vec2(uTexel.x, 0.0));
        float _hD = _topAt(aHUv - vec2(0.0, uTexel.y));
        float _hU = _topAt(aHUv + vec2(0.0, uTexel.y));
        vec3 objectNormal = normalize(cross(
          vec3(2.0 * uSpacing.x, _hR - _hL, 0.0),
          vec3(0.0, _hU - _hD, -2.0 * uSpacing.y)));`)
      // Displace the flat plane vertex up to its sampled height.
      .replace('#include <begin_vertex>', /* glsl */ `
        float _h = _topAt(aHUv);
        vec3 transformed = vec3(position.x, _h, position.z);
        vH = _h;
        vHole = _holeAt(aHUv);
        vDamage = uHasDamage > 0.5 ? texture2D(uDamage, aHUv).r : 0.0;
        vWUv = vec2(position.x, -position.z);`)

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', /* glsl */ `#include <common>
        uniform sampler2D uWoodTex;
        uniform vec2 uWoodScale;
        uniform float uThickness;
        uniform float uPainted;
        uniform vec3 uPaint;
        uniform vec3 uDamageRgb;
        varying float vDamage;
        varying float vH;
        varying float vHole;
        varying vec2 vWUv;`)
      .replace('#include <color_fragment>', /* glsl */ `#include <color_fragment>
        // Cut all the way through the stock — from this side alone, or from both until
        // the cuts met — → drop the fragment so the background shows through the hole.
        if (vHole > 0.999) discard;
        vec3 _wood = texture2D(uWoodTex, vWUv * uWoodScale).rgb;
        if (vH < uThickness - 0.001) {
          float _lum = dot(_wood, vec3(0.299, 0.587, 0.114));
          if (uPainted > 0.5) {
            // Painted-and-sanded: the cut holds paint. Modulated by the wood's own
            // luminance so the grooves keep some tooth instead of going flat black.
            _wood = uPaint * (0.85 + 0.3 * _lum);
          } else {
            // Freshly machined surfaces read lighter than the oxidized/aged outer
            // face: slightly desaturate, then gamma-lift carved fragments. The
            // gamma curve lightens dark species (walnut, cherry) strongly while
            // barely moving already-pale stock (maple), so the carve stays visible
            // on any wood without washing light ones out.
            _wood = mix(_wood, vec3(_lum), 0.2);
            _wood = pow(_wood, vec3(0.5));
          }
        }
        diffuseColor.rgb = mix(_wood, uDamageRgb, clamp(vDamage, 0.0, 1.0) * 0.85);`)
  }
}

// The stock bottom over the cut region (reusing the surface grid). Flat at Y=0 on an
// ordinary board; on a double-sided one it is the OTHER side's carve seen from below,
// displaced up to `b` (see TWO_SIDED_GLSL). It carries the wood colour like the rest of the
// block, lifted where it is cut as the top is, and discards wherever the column is cut
// through so a through-hole becomes a real hole rather than exposing a wood-coloured floor.
function patchFloorShader(
  mat: THREE.MeshLambertMaterial, texture: THREE.DataTexture,
  NX: number, NY: number, sx: number, sy: number, under: UnderUniforms,
) {
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, under)
    shader.uniforms.uHeight = { value: texture }
    shader.uniforms.uTexel = { value: new THREE.Vector2(1 / NX, 1 / NY) }
    shader.uniforms.uSpacing = { value: new THREE.Vector2(sx, sy) }
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', /* glsl */ `#include <common>
        uniform sampler2D uHeight;
        uniform vec2 uTexel;
        uniform vec2 uSpacing;
        attribute vec2 aHUv;
        varying float vHole;
        varying float vB;
        ${TWO_SIDED_GLSL}`)
      // The same graph-of-a-height normal as the top surface: it points up, and the
      // DoubleSide back face (which is what is seen from below) flips it down.
      .replace('#include <beginnormal_vertex>', /* glsl */ `
        float _bL = _bottomAt(aHUv - vec2(uTexel.x, 0.0));
        float _bR = _bottomAt(aHUv + vec2(uTexel.x, 0.0));
        float _bD = _bottomAt(aHUv - vec2(0.0, uTexel.y));
        float _bU = _bottomAt(aHUv + vec2(0.0, uTexel.y));
        vec3 objectNormal = normalize(cross(
          vec3(2.0 * uSpacing.x, _bR - _bL, 0.0),
          vec3(0.0, _bU - _bD, -2.0 * uSpacing.y)));`)
      .replace('#include <begin_vertex>', /* glsl */ `
        float _b = _bottomAt(aHUv);
        vec3 transformed = vec3(position.x, _b, position.z);
        vB = _b;
        vHole = _holeAt(aHUv);`)
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', /* glsl */ `#include <common>
        varying float vHole;
        varying float vB;`)
      .replace('#include <color_fragment>', /* glsl */ `#include <color_fragment>
        if (vHole > 0.999) discard;
        if (vB > 0.001) {
          // Cut from the other side: the same fresh-cut lift as the top surface's carve.
          float _lum = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
          diffuseColor.rgb = pow(mix(diffuseColor.rgb, vec3(_lum), 0.2), vec3(0.5));
        }`)
  }
}

// The static stock (walls + aprons) uses the wood texture via the standard
// Lambert map path (planar mm UVs baked in buildStock). This patch adds the
// Z0-datum highlight: each vertex carries aDatum (1 at the datum edge, 0 at the
// far edge; 0 on flat faces) and the fragment lerps the textured diffuse toward
// the datum color with squared falloff, matching the skirt's gradient.
function patchStockShader(mat: THREE.MeshLambertMaterial, datumColor: number) {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uDatum = { value: new THREE.Color(datumColor) }
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', /* glsl */ `#include <common>
        attribute float aDatum;
        varying float vDatum;`)
      .replace('#include <begin_vertex>', /* glsl */ `#include <begin_vertex>
        vDatum = aDatum;`)
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', /* glsl */ `#include <common>
        uniform vec3 uDatum;
        varying float vDatum;`)
      .replace('#include <color_fragment>', /* glsl */ `#include <color_fragment>
        diffuseColor.rgb = mix(diffuseColor.rgb, uDatum, vDatum * vDatum);`)
  }
}

// The boundary skirt is a vertical curtain whose bottom vertices sit at Y=0 and
// whose top vertices ride the sampled heightfield, so the stock edge follows the
// carve. Per-vertex aTop selects bottom (0) vs. top (sampled height); the diffuse
// is the same wood→datum gradient as the static walls, keyed on world Y. Columns
// cut clean through (sampled height ≈ 0) are discarded so the hole stays open.
function patchSkirtShader(
  mat: THREE.MeshLambertMaterial,
  texture: THREE.DataTexture,
  T: number,
  woodTex: THREE.Texture,
  tileMM: [number, number],
  datumColor: number,
  datumTop: boolean,
  under: UnderUniforms,
) {
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, under)
    shader.uniforms.uHeight = { value: texture }
    shader.uniforms.uWoodTex = { value: woodTex }
    shader.uniforms.uWoodScale = { value: new THREE.Vector2(1 / tileMM[0], 1 / tileMM[1]) }
    shader.uniforms.uDatum = { value: new THREE.Color(datumColor) }
    shader.uniforms.uThickness = { value: T }
    shader.uniforms.uDatumTop = { value: datumTop ? 1 : 0 }

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', /* glsl */ `#include <common>
        uniform sampler2D uHeight;
        attribute vec2 aHUv;     // texel-centre UV of the edge sample this vertex rides
        attribute float aTop;    // 1 = top (ride height), 0 = bottom (stay at Y=0)
        varying float vHole;
        varying float vWorldY;
        varying vec2 vWUv;       // wall wood UV in mm: (along-edge, height) — matches buildStock's wall UVs
        ${TWO_SIDED_GLSL}`)
      .replace('#include <begin_vertex>', /* glsl */ `
        // From the bottom surface (b, 0 on an ordinary board) up to the top one.
        float _y = aTop > 0.5 ? _topAt(aHUv) : _bottomAt(aHUv);
        vec3 transformed = vec3(position.x, _y, position.z);
        vHole = _holeAt(aHUv);
        vWorldY = _y;
        vWUv = vec2(position.x - position.z, _y);`)

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', /* glsl */ `#include <common>
        uniform sampler2D uWoodTex;
        uniform vec2 uWoodScale;
        uniform vec3 uDatum;
        uniform float uThickness;
        uniform float uDatumTop;
        varying float vHole;
        varying float vWorldY;
        varying vec2 vWUv;`)
      .replace('#include <color_fragment>', /* glsl */ `#include <color_fragment>
        if (vHole > 0.999) discard;
        float _f = uDatumTop > 0.5 ? vWorldY / uThickness : (uThickness - vWorldY) / uThickness;
        _f = clamp(_f, 0.0, 1.0);
        vec3 _wood = texture2D(uWoodTex, vWUv * uWoodScale).rgb;
        diffuseColor.rgb = mix(_wood, uDatum, _f * _f);`)
  }
}

export class HeightfieldMaterial {
  readonly group: THREE.Group
  readonly topZ: Float32Array
  readonly cellMM: number              // effective sample spacing (for logging)

  private readonly _sx: number          // sample spacing X (mm)
  private readonly _sy: number          // sample spacing Y (mm)
  private readonly _toolStates: ToolState[]
  private readonly _texture: THREE.DataTexture
  private readonly _surfaceGeo: THREE.BufferGeometry
  private readonly _surfaceMat: THREE.MeshLambertMaterial
  private readonly _floorMat: THREE.MeshLambertMaterial
  private readonly _stockGeo: THREE.BufferGeometry
  private readonly _stockMat: THREE.MeshLambertMaterial
  private readonly _skirtGeo: THREE.BufferGeometry | null
  private readonly _skirtMat: THREE.MeshLambertMaterial | null

  private readonly _hf: Heightfield
  // The rapids below the stock top (by segment index), carved like cuts, and the samples
  // whose surface one of them left — null when there are none, so a program whose rapids
  // all stay above the stock pays nothing.
  private readonly _carvedRapids: ReadonlySet<number>
  private readonly _damage: Uint8Array | null
  private readonly _damageTex: THREE.DataTexture | null
  private _lastFullIdx = -1
  private _lastPartialIdx = -1
  private _lastPartialT = 0
  private _catchingUp = false

  // A double-sided job's other side (sim/otherSide.ts): its finished program carved into a
  // second grid, read by every mesh as the bottom surface. Carved once, under the same
  // per-frame budget as a jump, and never reset by this side's rewinds.
  private readonly _under: UnderProgram | null
  private readonly _underHf: Heightfield | null
  private readonly _underTex: THREE.DataTexture | null
  private readonly _underUniforms: UnderUniforms
  private _underNext = 0

  constructor(
    W: number, H: number, T: number,
    segments: SimSegment[],
    toolStates: ToolState[],
    orgX: number, orgY: number,
    woodTex: THREE.Texture,
    // Physical (u, v) mm the wood tile covers — see woodTileMM in woodTexture.ts.
    tileMM: [number, number] = [DEFAULT_TILE_MM, DEFAULT_TILE_MM],
    zOrigin: ZOrigin = 'top',
    // Show the board painted and sanded back — cuts dark against bare wood — instead
    // of the fresh-cut look. See patchSurfaceShader.
    paintedCuts = false,
    // Below 1 the stock is drawn see-through (clear acrylic), so the carve and the
    // toolpaths inside it stay visible.
    opacity = 1,
    // A double-sided job's other side, already mirrored into this side's frame.
    under: UnderProgram | null = null,
  ) {
    this._toolStates = toolStates
    const carvedRapids = new Set<number>()
    segments.forEach((g, k) => { if (g.rapid && (g.prevZ < 0 || g.z < 0)) carvedRapids.add(k) })
    this._carvedRapids = carvedRapids

    // Grid only the region that actually gets cut, so resolution concentrates
    // there rather than being spread over the whole stock. The field itself (grid +
    // carve math) lives in sim/heightfield.ts so tests can drive the same code.
    // On a double-sided job the grid covers the other side's cuts as well.
    const underBounds = under ? computeCutBounds(under.segments, under.toolStates, orgX, orgY, W, H) : undefined
    const grid = gridForSegments(W, H, T, segments, toolStates, orgX, orgY, undefined, carvedRapids, underBounds)
    this._hf = new Heightfield(grid)
    this._under = under && under.segments.length > 0 ? under : null
    this._underHf = this._under ? new Heightfield(grid) : null
    const { NX, NY, gx0, gy0, bounds } = grid
    this._sx = grid.sx
    this._sy = grid.sy
    this.cellMM = this._hf.cellMM
    this.topZ = this._hf.topZ

    // Heightfield texture (one float per sample), nearest-sampled and texel-aligned.
    this._texture = new THREE.DataTexture(this.topZ, NX, NY, THREE.RedFormat, THREE.FloatType)
    this._texture.magFilter = THREE.NearestFilter
    this._texture.minFilter = THREE.NearestFilter
    this._texture.wrapS = THREE.ClampToEdgeWrapping
    this._texture.wrapT = THREE.ClampToEdgeWrapping
    this._texture.needsUpdate = true

    if (this._underHf) {
      this._underTex = new THREE.DataTexture(this._underHf.topZ, NX, NY, THREE.RedFormat, THREE.FloatType)
      this._underTex.magFilter = THREE.NearestFilter
      this._underTex.minFilter = THREE.NearestFilter
      this._underTex.wrapS = THREE.ClampToEdgeWrapping
      this._underTex.wrapT = THREE.ClampToEdgeWrapping
      this._underTex.needsUpdate = true
    } else {
      this._underTex = null
    }
    // With no other side the sampler is bound to this side's own texture and never read.
    this._underUniforms = {
      uUnder: { value: this._underTex ?? this._texture },
      uShowUnder: { value: this._underTex ? 1 : 0 },
      uThicknessU: { value: T },
    }

    if (carvedRapids.size > 0) {
      this._damage = new Uint8Array(NX * NY)
      this._damageTex = new THREE.DataTexture(this._damage, NX, NY, THREE.RedFormat, THREE.UnsignedByteType)
      this._damageTex.magFilter = THREE.NearestFilter
      this._damageTex.minFilter = THREE.NearestFilter
      // One byte per sample: rows are NX bytes, which WebGL's default 4-byte row alignment
      // would skew whenever NX is not a multiple of 4.
      this._damageTex.unpackAlignment = 1
      this._damageTex.needsUpdate = true
    } else {
      this._damage = null
      this._damageTex = null
    }

    // Static displaced plane over the cut region: vertex (i,j) at world
    // (gx0+i·sx, 0, -(gy0+j·sy)), uv at the matching texel centre so nearest
    // sampling fetches that sample exactly.
    const positions = new Float32Array(NX * NY * 3)
    const uvs = new Float32Array(NX * NY * 2)
    const woodUvs = new Float32Array(NX * NY * 2)   // planar mm/tile mapping for the floor's standard map
    for (let j = 0; j < NY; j++) {
      for (let i = 0; i < NX; i++) {
        const k = j * NX + i
        positions[k * 3] = gx0 + i * this._sx
        positions[k * 3 + 1] = 0
        positions[k * 3 + 2] = -(gy0 + j * this._sy)
        uvs[k * 2] = (i + 0.5) / NX
        uvs[k * 2 + 1] = (j + 0.5) / NY
        woodUvs[k * 2] = (gx0 + i * this._sx) / tileMM[0]
        woodUvs[k * 2 + 1] = (gy0 + j * this._sy) / tileMM[1]
      }
    }
    const indexCount = (NX - 1) * (NY - 1) * 6
    const indices = indexCount > 65535 ? new Uint32Array(indexCount) : new Uint16Array(indexCount)
    let o = 0
    for (let j = 0; j < NY - 1; j++) {
      for (let i = 0; i < NX - 1; i++) {
        const a = j * NX + i, b = a + 1, c = a + NX, d = c + 1
        indices[o++] = a; indices[o++] = c; indices[o++] = b
        indices[o++] = b; indices[o++] = c; indices[o++] = d
      }
    }
    this._surfaceGeo = new THREE.BufferGeometry()
    this._surfaceGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    this._surfaceGeo.setAttribute('aHUv', new THREE.BufferAttribute(uvs, 2))
    this._surfaceGeo.setAttribute('uv', new THREE.BufferAttribute(woodUvs, 2))
    this._surfaceGeo.setIndex(new THREE.BufferAttribute(indices, 1))

    this._surfaceMat = new THREE.MeshLambertMaterial({ side: THREE.DoubleSide })
    patchSurfaceShader(this._surfaceMat, this._texture, NX, NY, this._sx, this._sy, T, woodTex, tileMM, paintedCuts, this._damageTex, this._underUniforms)

    // Flat bottom of the stock over the cut region — reuses the surface grid
    // (undisplaced at Y=0) and punches through where the cut goes clean through.
    this._floorMat = new THREE.MeshLambertMaterial({ map: woodTex, side: THREE.DoubleSide })
    patchFloorShader(this._floorMat, this._texture, NX, NY, this._sx, this._sy, this._underUniforms)

    // Static stock geometry (wood): perimeter walls + bottom face, plus a flat
    // "apron" filling the uncut stock area around the gridded cut region so the
    // block still reads as full-size solid stock. All faces carry planar world-mm
    // UVs into the wood texture; the side walls additionally carry an aDatum
    // factor that fades the datum-highlight color in at the Z0 edge (top surface
    // or stock bottom, per zOrigin), giving a visual cue of where Z0 sits.
    this._stockMat = new THREE.MeshLambertMaterial({ map: woodTex, side: THREE.DoubleSide })
    patchStockShader(this._stockMat, Z_DATUM_COLOR_THREE)
    this._stockGeo = buildStock(W, H, T, bounds.x0, bounds.y0, bounds.x1, bounds.y1, zOrigin, tileMM)

    // Heightfield-driven "skirt" along any stock edge the cut region reaches (a
    // surfacing pass or a pocket overlapping the boundary). Its top edge samples
    // the same heightfield as the surface, so it drops with the carve instead of
    // leaving a full-height vertical lip where the static wall was omitted.
    this._skirtGeo = buildSkirt(NX, NY, this._sx, this._sy, gx0, gy0, W, H)
    if (this._skirtGeo) {
      this._skirtMat = new THREE.MeshLambertMaterial({ side: THREE.DoubleSide })
      patchSkirtShader(this._skirtMat, this._texture, T, woodTex, tileMM, Z_DATUM_COLOR_THREE, zOrigin === 'top', this._underUniforms)
    } else {
      this._skirtMat = null
    }

    // Every face shares one tint, so the order translucent layers blend in hardly
    // shows; depthWrite off keeps a near face from hiding the ones behind it.
    if (opacity < 1) {
      for (const m of [this._surfaceMat, this._floorMat, this._stockMat, this._skirtMat]) {
        if (!m) continue
        m.transparent = true
        m.opacity = opacity
        m.depthWrite = false
      }
    }

    this.group = new THREE.Group()
    this.group.add(new THREE.Mesh(this._surfaceGeo, this._surfaceMat))
    this.group.add(new THREE.Mesh(this._surfaceGeo, this._floorMat))
    this.group.add(new THREE.Mesh(this._stockGeo, this._stockMat))
    if (this._skirtGeo && this._skirtMat) {
      this.group.add(new THREE.Mesh(this._skirtGeo, this._skirtMat))
    }
  }

  get anyCarved(): boolean { return this._hf.anyCarved }

  reset() {
    this._hf.reset()
    this._damage?.fill(0)
    this._lastFullIdx = -1
    this._lastPartialIdx = -1
    this._lastPartialT = 0
    this._catchingUp = false
  }

  /** True while a jump is still being carved — the caller must keep the frame loop alive. */
  get catchingUp(): boolean { return this._catchingUp }

  // Incrementally carve completed segments plus the partial current one,
  // resetting if playback scrubbed backwards.
  //
  // A frame carves at most `budgetMs` worth and picks up where it left off on the next
  // one. Playback's per-frame increment is a handful of segments and never reaches the
  // budget; what does is a JUMP — loading a program (which opens on the finished part),
  // a rewind, a scrubber drag across the whole run. Carving a full-sheet program in one
  // go is ~2 s of arithmetic, and doing it inside a single frame froze the view and the
  // browser with it. Spread out, the part fills in over a few frames instead.
  //
  // Order does not matter to the result: every carve lowers cells to a minimum, so a
  // partially applied jump is exactly the same surface as the complete one, minus the
  // segments not reached yet.
  applyUpTo(segments: SimSegment[], segIdx: number, t: number, budgetMs = 24): boolean {
    if (segments.length === 0) return false

    // `_lastFullIdx` is the honest record of what has actually been carved (it lags
    // segIdx while catching up), so it — not the requested index — is what says whether
    // this call is asking for LESS than is already cut, which only a reset can undo.
    const goingBack = segIdx - 1 < this._lastFullIdx ||
      (segIdx === this._lastPartialIdx && t < this._lastPartialT - 1e-6)
    if (goingBack) {
      this.reset()
      // Side A run from the start: side B is not cut yet (sim/otherSide.ts).
      if (this._under?.hideOnRewind && this._underUniforms.uShowUnder.value !== 0) {
        this._underUniforms.uShowUnder.value = 0
        this._hf.dirty = true
      }
    }

    const deadline = performance.now() + budgetMs
    // The other side first: it is the ground this side's playback stands on.
    if (this._under && this._underHf && this._underNext < this._under.segments.length) {
      const us = this._under.segments
      let k = this._underNext
      for (; k < us.length; k++) {
        const s = us[k]
        if (isCuttingSeg(s)) {
          const ts = segTool(s, this._under.toolStates)
          this._underHf.carve(s.prevX, s.prevY, s.x, s.y, s.prevZ, s.z, ts.toolVbitHalfAngleTan, ts.toolBallNose, ts.toolDiameterMM, ts.toolTipRadiusMM, ts.toolCornerRadiusMM)
        }
        if ((k & 255) === 255 && performance.now() >= deadline) { k++; break }
      }
      this._underNext = k
      if (k < us.length) { this._catchingUp = true; return true }
    }
    const end = Math.min(segIdx, segments.length)
    let i = this._lastFullIdx + 1
    for (; i < end; i++) {
      const s = segments[i]
      const rapidCut = this._carvedRapids.has(i)
      if (rapidCut || isCuttingSeg(s)) {
        const ts = segTool(s, this._toolStates)
        this._hf.carve(s.prevX, s.prevY, s.x, s.y, s.prevZ, s.z, ts.toolVbitHalfAngleTan, ts.toolBallNose, ts.toolDiameterMM, ts.toolTipRadiusMM, ts.toolCornerRadiusMM,
          this._damage ?? undefined, rapidCut ? DAMAGED : 0)
      }
      // Checked in blocks: performance.now() per segment costs more than the carve on
      // the short moves a fine toolpath is made of.
      if ((i & 255) === 255 && performance.now() >= deadline) { i++; break }
    }
    this._lastFullIdx = i - 1
    if (i < end) {
      // Out of budget. The partial move below belongs on top of everything before it,
      // so it waits for the next frame along with the rest.
      this._catchingUp = true
      return this._hf.dirty
    }
    this._catchingUp = false

    const seg = segIdx < segments.length ? segments[segIdx] : null
    const rapidCut = this._carvedRapids.has(segIdx)
    if (seg && (rapidCut || isCuttingSeg(seg))) {
      const startT = segIdx === this._lastPartialIdx ? this._lastPartialT : 0
      if (t > startT + 1e-6) {
        const x0 = seg.prevX + (seg.x - seg.prevX) * startT
        const y0 = seg.prevY + (seg.y - seg.prevY) * startT
        const x1 = seg.prevX + (seg.x - seg.prevX) * t
        const y1 = seg.prevY + (seg.y - seg.prevY) * t
        const pz0 = seg.prevZ + (seg.z - seg.prevZ) * startT
        const pz1 = seg.prevZ + (seg.z - seg.prevZ) * t
        const ts = segTool(seg, this._toolStates)
        this._hf.carve(x0, y0, x1, y1, pz0, pz1, ts.toolVbitHalfAngleTan, ts.toolBallNose, ts.toolDiameterMM, ts.toolTipRadiusMM, ts.toolCornerRadiusMM,
          this._damage ?? undefined, rapidCut ? DAMAGED : 0)
      }
    }
    this._lastPartialIdx = segIdx
    this._lastPartialT = t

    return this._hf.dirty
  }

  // Re-upload the heightfield texture if it changed this frame. Returns whether
  // anything was uploaded (so the caller can flag a re-render).
  flushToGPU(): boolean {
    if (this._underHf?.dirty && this._underTex) {
      this._underTex.needsUpdate = true
      this._underHf.dirty = false
      this._hf.dirty = true
    }
    if (!this._hf.dirty) return false
    this._texture.needsUpdate = true
    if (this._damageTex) this._damageTex.needsUpdate = true
    this._hf.dirty = false
    return true
  }

  dispose() {
    this._surfaceGeo.dispose()
    this._surfaceMat.dispose()
    this._floorMat.dispose()
    this._stockGeo.dispose()
    this._stockMat.dispose()
    this._skirtGeo?.dispose()
    this._skirtMat?.dispose()
    this._texture.dispose()
    this._damageTex?.dispose()
    this._underTex?.dispose()
  }

}

// Static stock geometry (everything the heightfield surface does NOT draw):
// the 4 perimeter side walls + bottom face of the full stock block, plus a flat
// top "apron" tiling the uncut area between the stock edge and the gridded cut
// region [gx0..gx1]×[gy0..gy1]. Three-space: X = localX, Y = height, Z = -localY.
function buildStock(
  W: number, H: number, T: number,
  gx0: number, gy0: number, gx1: number, gy1: number,
  zOrigin: ZOrigin,
  tileMM: [number, number],
): THREE.BufferGeometry {
  const pos: number[] = []
  const uv: number[] = []
  const datum: number[] = []
  const idx: number[] = []

  // Per-vertex datum factor: 1 at the Z0 edge (y=T for top-origin, y=0 for
  // bottom-origin) fading to 0 at the far edge; patchStockShader applies the
  // squared-falloff lerp toward the datum color. Flat faces (colored=false) stay 0.
  const wallDatum = (y: number): number => (zOrigin === 'bottom' ? (T - y) / T : y / T)
  // Planar world-mm wood UVs: horizontal faces map (localX, localY); vertical
  // walls map (along-edge, height). The wall form (x - z = localX + localY, one
  // term constant per wall) matches the skirt shader's mapping so the textures
  // agree where a static wall meets a skirt strip.
  const su = 1 / tileMM[0]
  const sv = 1 / tileMM[1]
  const quad = (
    p0: [number, number, number], p1: [number, number, number],
    p2: [number, number, number], p3: [number, number, number],
    colored = false,
  ) => {
    const b = pos.length / 3
    pos.push(...p0, ...p1, ...p2, ...p3)
    for (const p of [p0, p1, p2, p3]) {
      if (colored) uv.push((p[0] - p[2]) * su, p[1] * sv)
      else uv.push(p[0] * su, -p[2] * sv)
      datum.push(colored ? wallDatum(p[1]) : 0)
    }
    idx.push(b, b + 1, b + 2, b, b + 2, b + 3)
  }

  // Perimeter walls of the full stock — gradient-tinted to mark the Z0 face.
  // Where the gridded cut region reaches a stock edge (no flat pad margin — the
  // cut runs off the boundary), that stretch of wall is omitted here and rebuilt
  // as a heightfield-driven skirt (buildSkirt) whose top follows the carved
  // surface, so no full-height lip is left at the stock edge. Interior cut
  // regions keep their 1 mm pad, so their grid edges stay at full T and the full
  // static wall is correct.
  const eps = 1e-6
  const touchL = gx0 <= eps, touchR = gx1 >= W - eps
  const touchF = gy0 <= eps, touchB = gy1 >= H - eps
  // Vertical wall along footprint segment (x0,v0)→(x1,v1) (world z = -v), full height.
  const wall = (x0: number, v0: number, x1: number, v1: number) => {
    if (Math.abs(x1 - x0) < eps && Math.abs(v1 - v0) < eps) return
    quad([x0, 0, -v0], [x1, 0, -v1], [x1, T, -v1], [x0, T, -v0], true)
  }
  if (touchL) { wall(0, 0, 0, gy0); wall(0, gy1, 0, H) } else wall(0, 0, 0, H)   // left   x=0
  if (touchR) { wall(W, 0, W, gy0); wall(W, gy1, W, H) } else wall(W, 0, W, H)   // right  x=W
  if (touchF) { wall(0, 0, gx0, 0); wall(gx1, 0, W, 0) } else wall(0, 0, W, 0)   // front  z=0
  if (touchB) { wall(0, H, gx0, H); wall(gx1, H, W, H) } else wall(0, H, W, H)   // back   z=-H

  // Flat apron strips, filling the stock minus the cut region. The top apron (y=T)
  // is the uncut surface around the gridded region; the bottom apron (y=0) is the
  // stock underside there. The cut region's top/bottom come from the heightfield
  // surface and floor meshes, so it's left open here (the floor mesh punches the
  // hole on a through-cut).
  const apron = (y: number) => (rx0: number, ry0: number, rx1: number, ry1: number) => {
    if (rx1 - rx0 > 1e-6 && ry1 - ry0 > 1e-6) {
      quad([rx0, y, -ry0], [rx1, y, -ry0], [rx1, y, -ry1], [rx0, y, -ry1])
    }
  }
  for (const y of [T, 0]) {
    const a = apron(y)
    a(0, 0, gx0, H)        // left of region (full height)
    a(gx1, 0, W, H)        // right of region (full height)
    a(gx0, 0, gx1, gy0)    // below region (middle column)
    a(gx0, gy1, gx1, H)    // above region (middle column)
  }

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3))
  geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uv), 2))
  geo.setAttribute('aDatum', new THREE.BufferAttribute(new Float32Array(datum), 1))
  geo.setIndex(idx)
  geo.computeVertexNormals()
  return geo
}

// Heightfield-driven side curtain along each stock edge the grid actually reaches
// (gx0≈0, gx1≈W, gy0≈0, gy1≈H — the edges where buildStock omits the static wall).
// One vertical strip per touched edge: a top vertex (rides the sampled height via
// patchSkirtShader) and a bottom vertex (Y=0) per edge sample, with constant
// outward normals for lighting. Returns null when no edge is reached (interior cut,
// the static walls already cover it). Three-space: X = localX, Z = -localY.
function buildSkirt(
  NX: number, NY: number, sx: number, sy: number,
  gx0: number, gy0: number, W: number, H: number,
): THREE.BufferGeometry | null {
  const eps = 1e-6
  const gx1 = gx0 + (NX - 1) * sx
  const gy1 = gy0 + (NY - 1) * sy
  const touchL = gx0 <= eps, touchR = gx1 >= W - eps
  const touchF = gy0 <= eps, touchB = gy1 >= H - eps
  if (!touchL && !touchR && !touchF && !touchB) return null

  const pos: number[] = []
  const huv: number[] = []
  const top: number[] = []
  const nor: number[] = []
  const idx: number[] = []

  // Add a strip of `count` samples; sampleAt(k) gives the world XZ, the texel UV
  // of that sample, and (nx,nz) is the edge's outward normal.
  const strip = (
    count: number,
    sampleAt: (k: number) => { x: number; z: number; u: number; v: number },
    nx: number, nz: number,
  ) => {
    const base = pos.length / 3
    for (let k = 0; k < count; k++) {
      const s = sampleAt(k)
      pos.push(s.x, 0, s.z); huv.push(s.u, s.v); top.push(0); nor.push(nx, 0, nz)  // bottom
      pos.push(s.x, 0, s.z); huv.push(s.u, s.v); top.push(1); nor.push(nx, 0, nz)  // top
    }
    for (let k = 0; k < count - 1; k++) {
      const b = base + k * 2
      idx.push(b, b + 2, b + 3, b, b + 3, b + 1)
    }
  }

  if (touchL) strip(NY, j => ({ x: gx0, z: -(gy0 + j * sy), u: 0.5 / NX, v: (j + 0.5) / NY }), -1, 0)
  if (touchR) strip(NY, j => ({ x: gx1, z: -(gy0 + j * sy), u: (NX - 0.5) / NX, v: (j + 0.5) / NY }), 1, 0)
  if (touchF) strip(NX, i => ({ x: gx0 + i * sx, z: -gy0, u: (i + 0.5) / NX, v: 0.5 / NY }), 0, 1)
  if (touchB) strip(NX, i => ({ x: gx0 + i * sx, z: -gy1, u: (i + 0.5) / NX, v: (NY - 0.5) / NY }), 0, -1)

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3))
  geo.setAttribute('aHUv', new THREE.BufferAttribute(new Float32Array(huv), 2))
  geo.setAttribute('aTop', new THREE.BufferAttribute(new Float32Array(top), 1))
  geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nor), 3))
  geo.setIndex(idx)
  return geo
}
