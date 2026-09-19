import * as THREE from 'three'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import type { ImportedPath, StlModelBounds } from './svgImporter'
import { nextPathColor } from './svgImporter'
import { uid } from '../uid'
import { round4 } from '../util/num'

export type { StlModelBounds }

export function parseStlGeometry(buffer: ArrayBuffer): THREE.BufferGeometry {
  const loader = new STLLoader()
  return loader.parse(buffer)
}

/** An STL's triangles, as the flat arrays every consumer actually reads. */
export interface StlMesh {
  positions: Float32Array
  indices: Uint32Array | null
}

// The last few models decoded, most recent first. A project normally carries one STL, and
// three things want it: the canvas preview, the Profile 3D generate, and the 3D view.
const MESH_CACHE_SIZE = 2
const meshCache: { src: string; mesh: StlMesh }[] = []

/**
 * Decode an STL path's `stlSrc` — ONCE per model, however many consumers ask.
 *
 * The model lives in the document as base64 (the whole file, 4/3 of its size), and
 * every consumer used to decode it for itself: `atob` into a binary string, a byte copy,
 * the STL parser, and a Float32Array copy of its vertices — on a 150 MB model a transient
 * several times the file, repeated by the canvas preview on every mount, by every
 * Profile 3D regenerate, and by the 3D view.
 *
 * THE ARRAYS ARE SHARED. Read them; never write to them, and never hand them to a worker
 * in a transfer list (which would detach them out from under the next caller). A worker
 * call's ordinary structured clone is fine — that copies.
 *
 * Matched by `===`, which for the same string object is a pointer comparison. Holds the
 * model's string alive while it is in the cache, so a deleted model is kept until two
 * other models have been decoded.
 */
export function decodeStlMesh(stlSrc: string): StlMesh {
  const hit = meshCache.findIndex((e) => e.src === stlSrc)
  if (hit >= 0) {
    const [entry] = meshCache.splice(hit, 1)
    meshCache.unshift(entry)
    return entry.mesh
  }
  const geo = parseStlGeometry(base64ToArrayBuffer(stlSrc))
  const pos = geo.attributes.position.array
  const mesh: StlMesh = {
    positions: pos instanceof Float32Array ? pos : new Float32Array(pos),
    indices: geo.index
      ? (geo.index.array instanceof Uint32Array ? geo.index.array : new Uint32Array(geo.index.array))
      : null,
  }
  geo.dispose()
  meshCache.unshift({ src: stlSrc, mesh })
  if (meshCache.length > MESH_CACHE_SIZE) meshCache.length = MESH_CACHE_SIZE
  return mesh
}

export function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes.buffer
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  const chunk = 8192
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunk, bytes.length)))
  }
  return btoa(binary)
}

export function importStl(
  buffer: ArrayBuffer,
  fileName: string,
  workpieceCX: number,
  workpieceCY: number,
): ImportedPath {
  const geo = parseStlGeometry(buffer)
  geo.computeBoundingBox()
  const bb = geo.boundingBox
  if (!bb) { geo.dispose(); throw new Error('Could not compute STL bounding box') }

  const stlModelBounds: StlModelBounds = {
    minX: bb.min.x, maxX: bb.max.x,
    minY: bb.min.y, maxY: bb.max.y,
    minZ: bb.min.z, maxZ: bb.max.z,
  }
  geo.dispose()

  const modelW = stlModelBounds.maxX - stlModelBounds.minX
  const modelH = stlModelBounds.maxY - stlModelBounds.minY
  if (modelW < 0.001 || modelH < 0.001) {
    throw new Error('STL model has zero or near-zero XY dimensions')
  }

  const hw = modelW / 2
  const hh = modelH / 2
  const d = `M${round4(workpieceCX - hw)},${round4(workpieceCY - hh)} L${round4(workpieceCX + hw)},${round4(workpieceCY - hh)} L${round4(workpieceCX + hw)},${round4(workpieceCY + hh)} L${round4(workpieceCX - hw)},${round4(workpieceCY + hh)} Z`

  return {
    id: uid('stl'),
    name: fileName,
    d,
    color: nextPathColor(),
    visible: true,
    stlSrc: arrayBufferToBase64(buffer),
    stlModelBounds,
  }
}
