import {
    ArrowLeft,
    ArrowRight,
    BookOpenText,
    Braces,
    Check,
    ChevronDown,
    ChevronRight,
    CircleAlert,
    Code2,
    Copy,
    Ellipsis,
    Eye,
    Folder,
    FolderInput,
    FolderOpen,
    Info,
    LayoutGrid,
    List,
    ListFilter,
    LoaderCircle,
    type LucideIcon,
    PanelLeft,
    PanelRight,
    Pencil,
    Plus,
    RefreshCw,
    Search,
    Settings,
    Trash2,
    WrapText,
    X,
} from "lucide-react";

export type DesktopIconName =
    | "sidebar"
    | "back"
    | "forward"
    | "inspector"
    | "preview"
    | "close"
    | "settings"
    | "search"
    | "refresh"
    | "add"
    | "copy"
    | "edit"
    | "import"
    | "folder"
    | "folder_open"
    | "reveal"
    | "more"
    | "list"
    | "loading"
    | "cards"
    | "deleted"
    | "filter"
    | "check"
    | "format"
    | "render"
    | "source"
    | "wrap"
    | "chevron_down"
    | "chevron_right"
    | "warning"
    | "info";

export interface DesktopIconProps {
    readonly name: DesktopIconName;
    readonly size?: number;
    readonly strokeWidth?: number;
}

const ICONS = Object.freeze({
    sidebar: PanelLeft,
    back: ArrowLeft,
    forward: ArrowRight,
    inspector: PanelRight,
    preview: Eye,
    close: X,
    settings: Settings,
    search: Search,
    refresh: RefreshCw,
    add: Plus,
    copy: Copy,
    edit: Pencil,
    import: FolderInput,
    folder: Folder,
    folder_open: FolderOpen,
    reveal: FolderOpen,
    more: Ellipsis,
    list: List,
    loading: LoaderCircle,
    cards: LayoutGrid,
    deleted: Trash2,
    filter: ListFilter,
    check: Check,
    format: Braces,
    render: BookOpenText,
    source: Code2,
    wrap: WrapText,
    chevron_down: ChevronDown,
    chevron_right: ChevronRight,
    warning: CircleAlert,
    info: Info,
} satisfies Readonly<Record<DesktopIconName, LucideIcon>>);

export function DesktopIcon({ name, size = 16, strokeWidth = 1.75 }: DesktopIconProps): React.JSX.Element {
    const Icon = ICONS[name];
    return <Icon aria-hidden="true" data-oaam-icon={name} focusable="false" size={size} strokeWidth={strokeWidth} />;
}
