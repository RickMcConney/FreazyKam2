import type { ToolType } from '../store/toolStore'
import endmillIcon from '../icons/endmill.svg'
import ballnoseIcon from '../icons/ballnose.svg'
import bullnoseIcon from '../icons/bullnose.svg'
import vbitIcon from '../icons/vbit.svg'
import taperIcon from '../icons/taper.svg'
import drillIcon from '../icons/drill.svg'

// How a tool type is drawn and named wherever tools are listed — the library and the
// tool browser show the same picture for the same bit.
export const TOOL_TYPE_ICON: Record<ToolType, string> = {
  endmill: endmillIcon,
  ballnose: ballnoseIcon,
  bullnose: bullnoseIcon,
  vbit: vbitIcon,
  taper: taperIcon,
  drill: drillIcon,
}

export const TOOL_TYPE_LABEL: Record<ToolType, string> = {
  endmill: 'End Mill',
  ballnose: 'Ball Nose',
  bullnose: 'Bull Nose',
  vbit: 'V-bit',
  taper: 'Taper End Mill',
  drill: 'Drill',
}

// Like cutters adjacent: the order the library's type dropdown lists them in.
export const TYPE_ORDER: ToolType[] = ['endmill', 'bullnose', 'ballnose', 'vbit', 'taper', 'drill']
