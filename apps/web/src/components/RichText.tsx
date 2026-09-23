import { useEffect, useState, type ReactNode } from 'react';
import { EditorContent, useEditor, useEditorState, type Editor, type JSONContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { TableKit } from '@tiptap/extension-table';
import { Placeholder } from '@tiptap/extensions';
import Highlight from '@tiptap/extension-highlight';
import {
  Bold,
  Code,
  CodeSquare,
  Heading2,
  Heading3,
  Highlighter,
  Italic,
  Link2,
  List,
  ListChecks,
  ListOrdered,
  Minus,
  Pilcrow,
  Quote,
  Redo2,
  Strikethrough,
  Table as TableIcon,
  Trash2,
  Underline as UnderlineIcon,
  Undo2,
} from 'lucide-react';
import type { RichText } from '@atlas/shared';
import { Button, Dialog, Field, Input } from '@/components/ui';
import { cn } from '@/lib/cn';

const SAFE_LINK = /^(https?:|mailto:|tel:|\/(?!\/)|#)/i;

function extensions(placeholder?: string) {
  return [
    StarterKit.configure({
      heading: { levels: [1, 2, 3, 4] },
      link: {
        openOnClick: false,
        autolink: true,
        defaultProtocol: 'https',
        HTMLAttributes: { rel: 'noopener noreferrer nofollow', target: '_blank' },
        // Mirrors the server's rule: only web, mail, phone, and in-app links.
        isAllowedUri: (url) => SAFE_LINK.test(url),
      },
    }),
    TaskList,
    TaskItem.configure({ nested: true }),
    TableKit.configure({ table: { resizable: false } }),
    Highlight,
    Placeholder.configure({ placeholder: placeholder ?? 'Start writing…' }),
  ];
}

/** Read-only rendering of stored rich text. */
export function RichTextView({
  content,
  className,
  label = 'Document content',
}: {
  content: RichText;
  className?: string;
  label?: string;
}) {
  const editor = useEditor(
    {
      extensions: extensions(),
      content: content as JSONContent,
      editable: false,
      injectCSS: false,
      immediatelyRender: true,
      // Read-only content is a document to read, not an input.
      editorProps: { attributes: { role: 'document', 'aria-label': label } },
    },
    [JSON.stringify(content)],
  );
  return <EditorContent editor={editor} className={cn('prose-atlas', className)} />;
}

function ToolButton({
  label,
  active,
  disabled,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className="grid size-8 place-items-center rounded-md text-text-2 hover:bg-surface-3 hover:text-text disabled:opacity-40 aria-pressed:bg-primary-soft aria-pressed:text-primary [&_svg]:size-4"
    >
      {children}
    </button>
  );
}

function Toolbar({ editor }: { editor: Editor }) {
  const [linking, setLinking] = useState(false);
  const state = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      paragraph: e.isActive('paragraph'),
      h2: e.isActive('heading', { level: 2 }),
      h3: e.isActive('heading', { level: 3 }),
      bold: e.isActive('bold'),
      italic: e.isActive('italic'),
      underline: e.isActive('underline'),
      strike: e.isActive('strike'),
      code: e.isActive('code'),
      highlight: e.isActive('highlight'),
      bullet: e.isActive('bulletList'),
      ordered: e.isActive('orderedList'),
      task: e.isActive('taskList'),
      quote: e.isActive('blockquote'),
      codeBlock: e.isActive('codeBlock'),
      link: e.isActive('link'),
      table: e.isActive('table'),
      canUndo: e.can().undo(),
      canRedo: e.can().redo(),
    }),
  });
  const chain = () => editor.chain().focus();
  const sep = <span className="mx-1 h-5 w-px bg-border" aria-hidden />;
  return (
    <div
      role="toolbar"
      aria-label="Formatting"
      className="sticky top-0 z-10 flex flex-wrap items-center gap-0.5 border-b border-border bg-surface-2/95 px-2 py-1.5 backdrop-blur"
    >
      <ToolButton label="Paragraph" active={state.paragraph} onClick={() => chain().setParagraph().run()}>
        <Pilcrow />
      </ToolButton>
      <ToolButton label="Heading" active={state.h2} onClick={() => chain().toggleHeading({ level: 2 }).run()}>
        <Heading2 />
      </ToolButton>
      <ToolButton label="Subheading" active={state.h3} onClick={() => chain().toggleHeading({ level: 3 }).run()}>
        <Heading3 />
      </ToolButton>
      {sep}
      <ToolButton label="Bold" active={state.bold} onClick={() => chain().toggleBold().run()}>
        <Bold />
      </ToolButton>
      <ToolButton label="Italic" active={state.italic} onClick={() => chain().toggleItalic().run()}>
        <Italic />
      </ToolButton>
      <ToolButton label="Underline" active={state.underline} onClick={() => chain().toggleUnderline().run()}>
        <UnderlineIcon />
      </ToolButton>
      <ToolButton label="Strikethrough" active={state.strike} onClick={() => chain().toggleStrike().run()}>
        <Strikethrough />
      </ToolButton>
      <ToolButton label="Highlight" active={state.highlight} onClick={() => chain().toggleHighlight().run()}>
        <Highlighter />
      </ToolButton>
      <ToolButton label="Inline code" active={state.code} onClick={() => chain().toggleCode().run()}>
        <Code />
      </ToolButton>
      <ToolButton label="Link" active={state.link} onClick={() => setLinking(true)}>
        <Link2 />
      </ToolButton>
      {sep}
      <ToolButton label="Bulleted list" active={state.bullet} onClick={() => chain().toggleBulletList().run()}>
        <List />
      </ToolButton>
      <ToolButton label="Numbered list" active={state.ordered} onClick={() => chain().toggleOrderedList().run()}>
        <ListOrdered />
      </ToolButton>
      <ToolButton label="Checklist" active={state.task} onClick={() => chain().toggleTaskList().run()}>
        <ListChecks />
      </ToolButton>
      <ToolButton label="Quote or callout" active={state.quote} onClick={() => chain().toggleBlockquote().run()}>
        <Quote />
      </ToolButton>
      <ToolButton label="Code block" active={state.codeBlock} onClick={() => chain().toggleCodeBlock().run()}>
        <CodeSquare />
      </ToolButton>
      <ToolButton label="Divider" onClick={() => chain().setHorizontalRule().run()}>
        <Minus />
      </ToolButton>
      <ToolButton
        label={state.table ? 'Delete table' : 'Insert table'}
        onClick={() =>
          state.table
            ? chain().deleteTable().run()
            : chain().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()
        }
      >
        {state.table ? <Trash2 /> : <TableIcon />}
      </ToolButton>
      {state.table && (
        <>
          <Button
            variant="ghost"
            size="sm"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => chain().addRowAfter().run()}
          >
            + Row
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => chain().addColumnAfter().run()}
          >
            + Column
          </Button>
        </>
      )}
      <span className="ml-auto flex gap-0.5">
        <ToolButton label="Undo" disabled={!state.canUndo} onClick={() => chain().undo().run()}>
          <Undo2 />
        </ToolButton>
        <ToolButton label="Redo" disabled={!state.canRedo} onClick={() => chain().redo().run()}>
          <Redo2 />
        </ToolButton>
      </span>
      {linking && <LinkDialog editor={editor} onClose={() => setLinking(false)} />}
    </div>
  );
}

function LinkDialog({ editor, onClose }: { editor: Editor; onClose: () => void }) {
  const [href, setHref] = useState<string>(() => editor.getAttributes('link').href ?? '');
  const [error, setError] = useState('');
  const apply = () => {
    const value = href.trim();
    if (!value) editor.chain().focus().extendMarkRange('link').unsetLink().run();
    else {
      const url = /^[a-z]+:|^\/|^#/i.test(value) ? value : `https://${value}`;
      if (!SAFE_LINK.test(url)) return setError('Use a web address, email (mailto:), or phone (tel:) link.');
      editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
    }
    onClose();
  };
  return (
    <Dialog
      open
      onClose={onClose}
      size="sm"
      title="Link"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={apply}>{href ? 'Apply link' : 'Remove link'}</Button>
        </>
      }
    >
      <Field label="Address" error={error || undefined} help="Leave empty to remove the link.">
        {(p) => (
          <Input
            {...p}
            autoFocus
            value={href}
            onChange={(e) => setHref(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                apply();
              }
            }}
            placeholder="https://"
          />
        )}
      </Field>
    </Dialog>
  );
}

/** Editable rich text with a formatting toolbar. Calls onChange with ProseMirror JSON. */
export function RichTextEditor({
  content,
  onChange,
  placeholder,
  label,
}: {
  content: RichText;
  onChange: (content: RichText) => void;
  placeholder?: string;
  label: string;
}) {
  const editor = useEditor({
    extensions: extensions(placeholder),
    content: content as JSONContent,
    injectCSS: false,
    immediatelyRender: true,
    editorProps: {
      attributes: {
        'aria-label': label,
        role: 'textbox',
        'aria-multiline': 'true',
        class: 'min-h-[320px] px-5 py-4 focus:outline-none',
      },
    },
    onUpdate: ({ editor: e }) => onChange(e.getJSON() as RichText),
  });
  useEffect(() => () => editor?.destroy(), [editor]);
  if (!editor) return null;
  return (
    <div className="overflow-hidden rounded-xl border border-border-strong bg-surface focus-within:border-primary focus-within:ring-3 focus-within:ring-primary/15">
      <Toolbar editor={editor} />
      <EditorContent editor={editor} className="prose-atlas" />
    </div>
  );
}
