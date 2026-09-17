import { useUIStore } from '../store/uiStore'

// Switches the bottom bar between the two strips. They look alike on purpose but are
// NOT the same list: Objects is the DOCUMENT (every path and operation, one chip each,
// click one to edit what made it), Operations
// is the program (what the machine will do, in the order it will do it). Reordering an
// operation changes the second without moving anything in the first.
export function BottomTabs() {
  const bottomTab = useUIStore((s) => s.bottomTab)
  const setBottomTab = useUIStore((s) => s.setBottomTab)
  const setTimelineOpen = useUIStore((s) => s.setTimelineOpen)

  const tab = (id: 'timeline' | 'operations', label: string, title: string) => (
    <button
      key={id}
      title={title}
      onClick={() => { setBottomTab(id); setTimelineOpen(true) }}
      className={[
        'px-2 py-0.5 text-[13px] rounded transition-colors',
        bottomTab === id
          ? 'bg-white dark:bg-neutral-700 text-gray-800 dark:text-neutral-100 shadow-sm'
          : 'text-gray-600 dark:text-neutral-400 hover:text-gray-800 dark:hover:text-neutral-200',
      ].join(' ')}
    >
      {label}
    </button>
  )

  return (
    <div className="flex items-center gap-0.5 p-0.5 rounded bg-gray-300 dark:bg-neutral-900 flex-shrink-0">
      {tab('timeline', 'Objects', 'Everything in the document — click a chip to edit it')}
      {tab('operations', 'Ops', 'Program — every toolpath, in the order the machine runs it')}
    </div>
  )
}
