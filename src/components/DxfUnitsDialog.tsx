import { useUIStore } from '../store/uiStore'
import { completeDxfImport } from '../io/importFile'
import type { DxfUnitsChoice } from '../importers/dxfImporter'

// Units prompt for DXF files with no $INSUNITS header. Driven by
// uiStore.pendingDxfImport so any import entry point (toolbar button, canvas
// drop) can open it. Renders nothing when no import is waiting.
export default function DxfUnitsDialog() {
  const pending = useUIStore((s) => s.pendingDxfImport)
  const setPending = useUIStore((s) => s.setPendingDxfImport)
  if (!pending) return null

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-white dark:bg-neutral-800 rounded-lg p-6 shadow-2xl w-80 border border-gray-200 dark:border-neutral-700">
        <h3 className="text-base font-semibold text-gray-900 dark:text-neutral-100 mb-1">DXF Units</h3>
        <p className="text-sm text-gray-500 dark:text-neutral-400 mb-4">
          This DXF file has no unit information. Select the drawing units:
        </p>
        <div className="grid grid-cols-3 gap-2 mb-4">
          {(['mm', 'cm', 'in', 'ft', 'm'] as DxfUnitsChoice[]).map((u) => (
            <button
              key={u}
              onClick={() => completeDxfImport(pending.text, pending.name, u)}
              className="px-3 py-2 rounded bg-gray-100 dark:bg-neutral-700 hover:bg-blue-100 dark:hover:bg-blue-900/40 text-sm font-medium text-gray-800 dark:text-neutral-200 transition-colors"
            >
              {u}
            </button>
          ))}
        </div>
        <button
          onClick={() => setPending(null)}
          className="w-full text-sm text-gray-600 hover:text-gray-800 dark:hover:text-neutral-300 transition-colors"
        >
          Cancel
        </button>
      </div>
    </div>
  )
}
