import { useCallback, useEffect, useRef, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Undo2, Redo2 } from 'lucide-react';
import { ArrowDownToLine, ArrowUpRight, Bookmark, ChevronDown, ChevronLeft, ChevronRight, ChevronsUpDown, CircleHelp, Combine, File, FileCheck2, FileImage, FileOutput, FilePenLine, FilePlus2, Files, FolderOpen, Hand, Highlighter, Home, LayoutGrid, List, Maximize, Menu, MessageSquare, Minus, MoreHorizontal, MousePointer2, PanelLeftClose, Pencil, Plus, Printer, RotateCw, Save, ScanLine, Search, ShieldCheck, Signature, SlidersHorizontal, Star, Sun, Type, X, ZoomIn, ZoomOut, type LucideIcon } from 'lucide-react';
import { closeDocument, native, openDocument, reopenDocument, editPages, saveCopy, splitDocument, cropPage, combineDocuments, insertPagesCopy, replacePagesCopy, documentFormFields, fillFormCopy, documentAnnotations, documentPageLabels, createComment, updateComment, deleteComment, createHighlight, createTextHighlight, updateHighlight, deleteHighlight, type Annotation, type CommentRect, type DocumentAnnotations, type DocumentFormFields, type FormPatch, type OpenResult, type SplitOutput, type SavedCopy } from './bridge';
import { clampPage, toolGroups, type DocumentInfo, type PageEdit } from './model';
import { pageLabelDescription, pageLabelFor, validatePageLabels, type DocumentPageLabels } from './pageLabels';
import Viewer from './Viewer';
import Organizer from './Organizer';
import ConfirmDialog from './ConfirmDialog';
import Updates from './Updates';
import SearchPanel, { type ActiveSearch } from './SearchPanel';
import BookmarksPanel from './BookmarksPanel';
import PageText from './PageText';
import PasswordDialog from './PasswordDialog';
import PrintDialog from './PrintDialog';
import DocumentProperties from './DocumentProperties';
import DependencyNotices from './DependencyNotices';
import CombineDialog from './CombineDialog';
import InsertPagesDialog from './InsertPagesDialog';
import ReplacePagesDialog from './ReplacePagesDialog';
import FillFormsDialog from './FillFormsDialog';
import CommentsPanel from './CommentsPanel';
import CommentEditor, { type AnnotationDraft } from './CommentEditor';
import type { TextHighlightSelection, TextHighlightSelectionSource } from './textHighlightSelection';
import { readPreferences, savePreferences } from './preferences';
import { readRecentFiles, saveRecentFiles, rememberFile } from './recentFiles';
import s from './Workspace.module.css';

const icons: Record<string, LucideIcon> = { 'Create a PDF': FilePlus2, 'Combine files': Combine, 'Organize pages': LayoutGrid, 'Edit a PDF': FilePenLine, 'Export a PDF': FileOutput, 'Scan & OCR': ScanLine, 'Fill forms': Signature, 'Protect a PDF': ShieldCheck, 'Comment': MessageSquare, 'Compress a PDF': ArrowDownToLine };
function IconButton({ icon: Icon, label, onClick, onPointerDown, disabled = false, active = false }: { icon: LucideIcon; label: string; onClick?: () => void; onPointerDown?: () => void; disabled?: boolean; active?: boolean }) {
  return <button className={`${s.iconButton} ${active ? s.activeIcon : ''}`} aria-label={label} title={disabled && !onClick ? `${label} — not implemented yet` : label} onPointerDown={onPointerDown} onClick={onClick} disabled={disabled}><Icon size={19} strokeWidth={1.7} /></button>;
}
type AnnotationsLoad = { request: string; annotations: DocumentAnnotations | null; error: string };
type FormsLoad = { request: string; fields: DocumentFormFields | null; error: string };
type PageLabelsLoad = { request: string; labels: DocumentPageLabels | null };

export default function App() {
  const [preferences] = useState(readPreferences);
  const [documents, setDocuments] = useState<DocumentInfo[]>([]);
  const [active, setActive] = useState<number | null>(null);
  const [view, setView] = useState<'home' | 'tools' | 'document'>('home');
  const [section, setSection] = useState('Recent');
  const [query, setQuery] = useState('');
  const [toolsOpen, setToolsOpen] = useState(preferences.toolsOpen);
  const [nav, setNav] = useState(preferences.nav);
  const [searchOpen, setSearchOpen] = useState(false);
  const [activeSearch, setActiveSearch] = useState<ActiveSearch | null>(null);
  const [bookmarksOpen, setBookmarksOpen] = useState(false);
  const [pageTextOpen, setPageTextOpen] = useState(false);
  const [printOpen, setPrintOpen] = useState(false);
  const [propertiesOpen, setPropertiesOpen] = useState(false);
  const [noticesOpen, setNoticesOpen] = useState(false);
  const [passwordRequest, setPasswordRequest] = useState<{ challenge: Extract<OpenResult, { status: 'password_required' }>; organize: boolean } | null>(null);
  useEffect(() => { if (searchOpen) setBookmarksOpen(false); }, [searchOpen]);
  const [menu, setMenu] = useState(false);
  const [updatesOpen, setUpdatesOpen] = useState(false);
  const [dark, setDark] = useState(preferences.dark);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [zoom, setZoom] = useState(preferences.zoom);
  const [fit, setFit] = useState(preferences.fit);
  const [hand, setHand] = useState(preferences.hand);
  const [page, setPage] = useState(0);
  const readingPages = useRef(new Map<number, number>());
  const [target, setTarget] = useState({ page: 0, token: 0 });
  const [recentFiles, setRecentFiles] = useState(readRecentFiles);
  const [organizing, setOrganizing] = useState(false);
  const [combineOpen, setCombineOpen] = useState(false);
  const [insertOpen, setInsertOpen] = useState(false);
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [formsOpen, setFormsOpen] = useState(false);
  const [formsLoad, setFormsLoad] = useState<FormsLoad>({ request: '', fields: null, error: '' });
  const [replaceRange, setReplaceRange] = useState({ start: 0, count: 1 });
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [commentMode, setCommentMode] = useState(false);
  const [highlightMode, setHighlightMode] = useState(false);
  const [annotationsLoad, setAnnotationsLoad] = useState<AnnotationsLoad>({ request: '', annotations: null, error: '' });
  const [pageLabelsLoad, setPageLabelsLoad] = useState<PageLabelsLoad>({ request: '', labels: null });
  const [commentEditor, setCommentEditor] = useState<AnnotationDraft | null>(null);
  const [textHighlightSelection, setTextHighlightSelection] = useState<TextHighlightSelection | null>(null);
  const retainedTextHighlightSelection = useRef<TextHighlightSelection | null>(null);
  const pointerTextHighlightSelection = useRef<TextHighlightSelection | null>(null);
  const [pendingClose, setPendingClose] = useState<number | 'window' | null>(null);
  const closingDocument = useRef<number | null>(null);
  useEffect(() => {
    if (!savePreferences({ dark, zoom, fit, hand, toolsOpen, nav })) setNotice('Your reading preferences could not be saved. They will last for this session only.');
  }, [dark, zoom, fit, hand, toolsOpen, nav]);
  useEffect(() => {
    if (!saveRecentFiles(recentFiles)) setNotice('Recent files and stars could not be saved. They will last for this session only.');
  }, [recentFiles]);
  const latest = useRef({ documents, busy, active });
  latest.current = { documents, busy, active };
  useEffect(() => {
    if (!native) return;
    const unlisten = getCurrentWindow().onCloseRequested(event => {
      if (latest.current.busy || closingDocument.current !== null) { event.preventDefault(); setNotice('Wait for the current operation to finish before closing.'); }
      else if (latest.current.documents.some(document => document.dirty)) { event.preventDefault(); setPendingClose('window'); }
    });
    return () => { void unlisten.then(stop => stop()); };
  }, []);
  const doc = documents.find(d => d.id === active);
  const receiveSearch = useCallback((search: ActiveSearch | null) => setActiveSearch(search), []);
  const closeSearch = useCallback(() => { setSearchOpen(false); setActiveSearch(null); }, []);
  useEffect(() => { setActiveSearch(null); }, [active, doc?.revision, organizing, searchOpen]);
  useEffect(() => { setCommentMode(false); setHighlightMode(false); setCommentsOpen(false); setCommentEditor(null); setFormsOpen(false); }, [active]);
  useEffect(() => { retainedTextHighlightSelection.current = null; pointerTextHighlightSelection.current = null; setTextHighlightSelection(null); }, [active, doc?.revision, hand, commentMode, highlightMode]);
  const annotationsNeeded = commentMode || highlightMode || commentsOpen || commentEditor !== null || textHighlightSelection !== null;
  const annotationsRequest = doc ? `${doc.id}:${doc.revision}` : '';
  useEffect(() => {
    if (!doc || !annotationsNeeded) { setAnnotationsLoad({ request: '', annotations: null, error: '' }); return; }
    let disposed = false;
    setAnnotationsLoad({ request: annotationsRequest, annotations: null, error: '' });
    documentAnnotations(doc.id, doc.revision).then(value => {
      if (disposed || value.documentId !== doc.id || value.revision !== doc.revision) return;
      setAnnotationsLoad({ request: annotationsRequest, annotations: value, error: '' });
    }).catch(reason => { if (!disposed) setAnnotationsLoad({ request: annotationsRequest, annotations: null, error: String(reason) }); });
    return () => { disposed = true; };
  }, [annotationsNeeded, annotationsRequest, doc?.id, doc?.revision]);
  const annotations = annotationsLoad.request === annotationsRequest ? annotationsLoad.annotations : null;
  const formsRequest = doc ? `${doc.id}:${doc.revision}` : '';
  useEffect(() => {
    if (!doc || !formsOpen) { setFormsLoad({ request: '', fields: null, error: '' }); return; }
    let disposed = false;
    setFormsLoad({ request: formsRequest, fields: null, error: '' });
    documentFormFields(doc.id, doc.revision).then(value => {
      if (disposed || value.documentId !== doc.id || value.revision !== doc.revision) return;
      setFormsLoad({ request: formsRequest, fields: value, error: '' });
    }).catch(reason => { if (!disposed) setFormsLoad({ request: formsRequest, fields: null, error: String(reason) }); });
    return () => { disposed = true; };
  }, [doc?.id, doc?.revision, formsOpen, formsRequest]);
  const formFields = formsLoad.request === formsRequest ? formsLoad.fields : null;
  const pageLabelsRequest = doc ? `${doc.id}:${doc.revision}` : '';
  useEffect(() => {
    if (!doc || typeof documentPageLabels !== 'function') { setPageLabelsLoad({ request: '', labels: null }); return; }
    let disposed = false;
    const { id, revision, pages } = doc;
    setPageLabelsLoad({ request: pageLabelsRequest, labels: null });
    Promise.resolve().then(() => documentPageLabels(id, revision)).then(value => {
      if (disposed) return;
      const snapshot = validatePageLabels(value, pages.length);
      if (!snapshot || snapshot.documentId !== id || snapshot.revision !== revision) return;
      setPageLabelsLoad({ request: pageLabelsRequest, labels: snapshot });
    }).catch(() => {});
    return () => { disposed = true; };
  }, [doc?.id, doc?.revision, doc?.pages.length, pageLabelsRequest]);
  const pageLabels = pageLabelsLoad.request === pageLabelsRequest ? pageLabelsLoad.labels : null;
  const activate = (id: number) => {
    if (busy || closingDocument.current !== null) return;
    const document = documents.find(item => item.id === id);
    if (!document) return;
    const next = clampPage(readingPages.current.get(id) ?? 0, document.pages.length);
    setActive(id); setView('document'); setPage(next); setTarget(value => ({ page: next, token: value.token + 1 }));
  };
  const trackPage = (value: number) => { if (doc) { const next = clampPage(value, doc.pages.length); readingPages.current.set(doc.id, next); setPage(next); } };
  const opened = (info: DocumentInfo, organize: boolean) => {
    setDocuments(list => [...list, info]); setRecentFiles(list => rememberFile(list, info)); setOrganizing(organize);
    setActive(info.id); setView('document'); setPage(0); setTarget(value => ({ page: 0, token: value.token + 1 }));
  };
  const acceptOpen = (result: OpenResult | null, organize: boolean) => {
    if (result?.status === 'opened') opened(result.document, organize);
    else if (result?.status === 'password_required') setPasswordRequest({ challenge: result, organize });
  };
  const open = useCallback(async (example = false, organize = false) => {
    if (busy || closingDocument.current !== null) return;
    setBusy(true); setError(''); setMenu(false);
    try {
      acceptOpen(await openDocument(example), organize);
    } catch (e) { setError(String(e)); } finally { setBusy(false); }
  }, [busy]);
  const reopen = async (path: string) => {
    if (busy || closingDocument.current !== null) return;
    const existing = documents.find(document => document.path === path);
    if (existing) { activate(existing.id); return; }
    setBusy(true); setError('');
    try {
      acceptOpen(await reopenDocument(path), false);
    } catch (e) { setError(`Could not reopen this file. It may have moved or been deleted. ${String(e)}`); }
    finally { setBusy(false); }
  };
  const close = async (id: number, discard = false) => {
    if (busy || closingDocument.current !== null) return;
    if (!discard && documents.find(document => document.id === id)?.dirty) { setPendingClose(id); return; }
    closingDocument.current = id; setBusy(true); setError('');
    try {
      await closeDocument(id); readingPages.current.delete(id); setDocuments(list => list.filter(d => d.id !== id));
      if (latest.current.active === id) { setActive(null); setView('home'); }
    } catch (e) { setError(String(e)); }
    finally { closingDocument.current = null; setBusy(false); }
  };
  const updateDocument = (info: DocumentInfo) => {
    setDocuments(list => list.map(document => document.id === info.id ? info : document));
    const next = clampPage(page, info.pages.length); readingPages.current.set(info.id, next); setPage(next); setTarget(value => ({ page: next, token: value.token + 1 }));
  };
  const edit = async (action: PageEdit): Promise<boolean> => {
    if (!doc || busy || closingDocument.current !== null) return false;
    setBusy(true); setError(''); setNotice('');
    try { updateDocument(await editPages(doc.id, action)); return true; }
    catch (e) { setError(String(e)); return false; } finally { setBusy(false); }
  };
  const save = async (pages?: number[]) => {
    if (!doc || busy || closingDocument.current !== null) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await saveCopy(doc.id, pages);
      if (result) { updateDocument(result.document); setNotice(`Saved ${pages ? 'selected pages' : 'a copy'} to ${result.path}`); }
    } catch (e) { setError(String(e)); } finally { setBusy(false); }
  };
  const split = async (pagesPerFile: number): Promise<SplitOutput | null> => {
    if (!doc || busy || closingDocument.current !== null) return null;
    setBusy(true); setError(''); setNotice('');
    try { return await splitDocument(doc.id, doc.revision, pagesPerFile); }
    finally { setBusy(false); }
  };
  const crop = async (cropPageIndex: number, rect: { x: number; y: number; width: number; height: number }): Promise<void> => {
    if (!doc || busy || closingDocument.current !== null) throw new Error('The document is no longer ready to crop.');
    setBusy(true); setError(''); setNotice('');
    try { updateDocument(await cropPage(doc.id, cropPageIndex, doc.revision, rect)); }
    finally { setBusy(false); }
  };
  const mutateAnnotation = async (operation: (document: DocumentInfo) => Promise<DocumentInfo>) => {
    const current = doc;
    if (!current || busy || closingDocument.current !== null) throw new Error('The document is no longer ready for comments.');
    const latestDocument = latest.current.documents.find(document => document.id === current.id);
    if (!latestDocument || latestDocument.revision !== current.revision) throw new Error('The document changed. Reload its comments and try again.');
    setBusy(true); setError(''); setNotice('');
    try { updateDocument(await operation(current)); }
    finally { setBusy(false); }
  };
  const receiveTextHighlightSelection = useCallback((selection: TextHighlightSelection | null, source: TextHighlightSelectionSource) => {
    if (!selection || !doc || busy || hand || commentMode || highlightMode || selection.id !== doc.id || selection.revision !== doc.revision || selection.page < 0 || selection.page >= doc.pages.length || selection.start < 0 || selection.end <= selection.start) {
      setTextHighlightSelection(current => current?.id === source.id && current.page === source.page && current.revision === source.revision ? null : current);
      if (retainedTextHighlightSelection.current?.id === source.id && retainedTextHighlightSelection.current.page === source.page && retainedTextHighlightSelection.current.revision === source.revision) retainedTextHighlightSelection.current = null;
      return;
    }
    pointerTextHighlightSelection.current = null;
    retainedTextHighlightSelection.current = selection;
    setTextHighlightSelection(selection);
  }, [busy, commentMode, doc, hand, highlightMode]);
  const captureTextHighlightSelection = () => { pointerTextHighlightSelection.current = retainedTextHighlightSelection.current; };
  const beginTextHighlight = () => {
    const selection = pointerTextHighlightSelection.current || retainedTextHighlightSelection.current;
    pointerTextHighlightSelection.current = null;
    if (!doc || busy || hand || commentMode || highlightMode || annotations?.status !== 'supported' || !selection || selection.id !== doc.id || selection.revision !== doc.revision || selection.page < 0 || selection.page >= doc.pages.length || !Number.isSafeInteger(selection.start) || !Number.isSafeInteger(selection.end) || selection.start < 0 || selection.end <= selection.start) return;
    retainedTextHighlightSelection.current = null;
    setTextHighlightSelection(null);
    setCommentsOpen(true);
    setCommentEditor({ kind: 'create-text-highlight', page: selection.page, start: selection.start, end: selection.end });
  };
  const beginComment = (commentPage: number, rect: CommentRect) => {
    if (!doc || busy || annotations?.status !== 'supported') return;
    setHighlightMode(false); setCommentsOpen(true); setCommentEditor({ kind: 'create', type: 'note', page: commentPage, rect });
  };
  const beginHighlight = (highlightPage: number, rect: CommentRect) => {
    if (!doc || busy || annotations?.status !== 'supported') return;
    setCommentMode(false); setCommentsOpen(true); setCommentEditor({ kind: 'create', type: 'area-highlight', page: highlightPage, rect });
  };
  const selectAnnotation = (annotation: Annotation) => {
    if (!doc || busy) return;
    go(annotation.page); setCommentsOpen(true); setCommentEditor({ kind: 'edit', annotation });
  };
  const addCommentOnCurrentPage = () => {
    if (!doc || busy || annotations?.status !== 'supported') return;
    setHand(false); setHighlightMode(false); setCommentMode(true); setCommentsOpen(false);
  };
  const addHighlightOnCurrentPage = () => {
    if (!doc || busy || annotations?.status !== 'supported') return;
    setHand(false); setCommentMode(false); setHighlightMode(true); setCommentsOpen(false);
  };
  const launchComments = () => {
    if (!doc || busy || closingDocument.current !== null) return;
    closeSearch(); setBookmarksOpen(false); setOrganizing(false); setView('document'); setCommentsOpen(true);
  };
  const launchCommentMode = () => {
    launchComments(); setHand(false); setHighlightMode(false); setCommentMode(true);
  };
  const launchHighlightMode = () => {
    launchComments(); setHand(false); setCommentMode(false); setHighlightMode(true);
  };
  const combine = async (first: { id: number; revision: number }, second: { id: number; revision: number }): Promise<SavedCopy | null> => {
    if (busy || closingDocument.current !== null) throw new Error('The workspace is not ready to combine PDFs.');
    if (first.id === second.id) throw new Error('Choose two different open PDFs.');
    const firstDocument = documents.find(document => document.id === first.id);
    const secondDocument = documents.find(document => document.id === second.id);
    if (!firstDocument || !secondDocument) throw new Error('One selected PDF is no longer open. Choose two open PDFs.');
    if (firstDocument.revision !== first.revision || secondDocument.revision !== second.revision) throw new Error('A selected PDF changed. Choose the order again.');
    if (firstDocument.pages.length + secondDocument.pages.length > 4096) throw new Error('These PDFs exceed the 4,096-page combine limit.');
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await combineDocuments(first, second);
      if (result) opened(result.document, false);
      return result;
    } finally { setBusy(false); }
  };
  const insert = async (target: { id: number; revision: number }, donor: { id: number; revision: number }, at: number): Promise<SavedCopy | null> => {
    if (busy || closingDocument.current !== null) throw new Error('The workspace is not ready to insert pages.');
    if (target.id === donor.id) throw new Error('Choose two different open PDFs.');
    if (!Number.isSafeInteger(at) || at < 0) throw new Error('Choose a valid insertion boundary.');
    const targetDocument = documents.find(document => document.id === target.id);
    const donorDocument = documents.find(document => document.id === donor.id);
    if (!targetDocument || !donorDocument) throw new Error('One selected PDF is no longer open. Choose two open PDFs.');
    if (targetDocument.revision !== target.revision || donorDocument.revision !== donor.revision) throw new Error('A selected PDF changed. Choose the documents again.');
    if (at > targetDocument.pages.length) throw new Error('Choose a valid insertion boundary.');
    if (targetDocument.pages.length + donorDocument.pages.length > 4096) throw new Error('These PDFs exceed the 4,096-page insert limit.');
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await insertPagesCopy(target, donor, at);
      if (result) opened(result.document, false);
      return result;
    } finally { setBusy(false); }
  };
  const replace = async (target: { id: number; revision: number }, donor: { id: number; revision: number }, start: number, count: number): Promise<SavedCopy | null> => {
    if (busy || closingDocument.current !== null) throw new Error('The workspace is not ready to replace pages.');
    if (target.id === donor.id) throw new Error('Choose two different open PDFs.');
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(count) || start < 0 || count < 1) throw new Error('Choose one valid target page range.');
    const targetDocument = documents.find(document => document.id === target.id);
    const donorDocument = documents.find(document => document.id === donor.id);
    if (!targetDocument || !donorDocument) throw new Error('One selected PDF is no longer open. Choose two open PDFs.');
    if (targetDocument.revision !== target.revision || donorDocument.revision !== donor.revision) throw new Error('A selected PDF changed. Choose the documents again.');
    if (start + count > targetDocument.pages.length) throw new Error('Choose one valid target page range.');
    if (targetDocument.pages.length + donorDocument.pages.length > 4096) throw new Error('These input PDFs exceed the 4,096-page replace limit.');
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await replacePagesCopy(target, donor, start, count);
      if (result) opened(result.document, false);
      return result;
    } finally { setBusy(false); }
  };
  const fillForms = async (id: number, revision: number, values: FormPatch[]): Promise<SavedCopy | null> => {
    if (busy || closingDocument.current !== null) throw new Error('The workspace is not ready to fill this form.');
    const source = documents.find(document => document.id === id);
    if (!source || source.revision !== revision) throw new Error('This PDF changed. Reload its fields and try again.');
    if (!values.length || values.some(value => !value.fieldId)) throw new Error('Change at least one field before saving a new copy.');
    if (new Set(values.map(value => value.fieldId)).size !== values.length) throw new Error('This form contains duplicate field updates. Reload it and try again.');
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await fillFormCopy(id, revision, values);
      if (result) opened(result.document, false);
      return result;
    } finally { setBusy(false); }
  };
  const launchOrganizer = () => { if (busy || closingDocument.current !== null) return; if (doc) { setOrganizing(true); setView('document'); } else void open(false, true); };
  const launchCombine = () => {
    if (busy || closingDocument.current !== null) return;
    if (documents.length < 2) { setNotice('Open two PDFs to combine them.'); return; }
    setMenu(false); setOrganizing(false); setView('document'); setCombineOpen(true);
  };
  const launchForms = () => {
    if (!doc || busy || closingDocument.current !== null) return;
    setMenu(false); setOrganizing(false); closeSearch(); setBookmarksOpen(false); setFormsOpen(true);
  };
  const launchInsert = () => {
    if (busy || closingDocument.current !== null) return;
    if (documents.length < 2) { setNotice('Open two PDFs to insert pages into a new copy.'); return; }
    setMenu(false); setInsertOpen(true);
  };
  const launchReplace = (selected: number[]) => {
    if (busy || closingDocument.current !== null) return;
    if (documents.length < 2) { setNotice('Open two PDFs to replace pages in a new copy.'); return; }
    if (!selected.length || selected.some((pageNumber, index) => pageNumber !== selected[0] + index)) { setNotice('Select one contiguous target page range to replace.'); return; }
    setReplaceRange({ start: selected[0], count: selected.length }); setMenu(false); setReplaceOpen(true);
  };
  const go = (value: number) => { if (doc) { const next = clampPage(value, doc.pages.length); trackPage(next); setTarget(v => ({ page: next, token: v.token + 1 })); } };
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (updatesOpen || pageTextOpen || printOpen || propertiesOpen || noticesOpen || passwordRequest || pendingClose !== null || combineOpen || insertOpen || replaceOpen || commentEditor) return;
      if ((event.target as HTMLElement | null)?.closest?.('dialog')) return;
      if (event.ctrlKey && event.key.toLowerCase() === 'o') { event.preventDefault(); void open(); }
      if (event.ctrlKey && event.key.toLowerCase() === 'f' && doc) { event.preventDefault(); setView('document'); setOrganizing(false); setSearchOpen(true); return; }
      if (event.ctrlKey && event.key.toLowerCase() === 'p' && doc) { event.preventDefault(); if (!busy) setPrintOpen(true); return; }
      if (event.ctrlKey && event.key.toLowerCase() === 'd' && doc) { event.preventDefault(); if (!busy) setPropertiesOpen(true); return; }
      if (event.key === 'Escape' && searchOpen) { closeSearch(); return; }
      if (event.key === 'Escape' && (commentsOpen || commentMode || highlightMode)) { setCommentsOpen(false); setCommentMode(false); setHighlightMode(false); return; }
      if ((event.target as HTMLElement).matches('input,select,textarea')) return;
      if (event.key === 'F4') { event.preventDefault(); event.shiftKey ? setToolsOpen(v => !v) : setNav(v => !v); }
      if (event.ctrlKey && event.key === '2') { event.preventDefault(); setFit(true); }
      if (event.ctrlKey && event.key === '1') { event.preventDefault(); setFit(false); setZoom(100); }
      if (view !== 'document' || !doc) return;
      if (event.ctrlKey && event.key.toLowerCase() === 's') { event.preventDefault(); void save(); return; }
      if (event.ctrlKey && event.key.toLowerCase() === 'z') { event.preventDefault(); void edit({ kind: event.shiftKey ? 'redo' : 'undo' }); return; }
      if (event.ctrlKey && event.key.toLowerCase() === 'y') { event.preventDefault(); void edit({ kind: 'redo' }); return; }
      if (event.key === 'PageDown') { event.preventDefault(); go(page + 1); }
      if (event.key === 'PageUp') { event.preventDefault(); go(page - 1); }
      if (event.key === 'Home') { event.preventDefault(); go(0); }
      if (event.key === 'End') { event.preventDefault(); go(doc.pages.length - 1); }
      if (event.key.toLowerCase() === 'h' && !event.ctrlKey) { setHand(true); setCommentMode(false); setHighlightMode(false); }
      if (event.ctrlKey && event.key === 'Tab') { event.preventDefault(); const i = documents.findIndex(d => d.id === active); activate(documents[(i + 1) % documents.length].id); }
      if (event.ctrlKey && event.key.toLowerCase() === 'w') { event.preventDefault(); void close(doc.id); }
    };
    window.addEventListener('keydown', listener); return () => window.removeEventListener('keydown', listener);
  });
  const listed = recentFiles.filter(d => d.name.toLowerCase().includes(query.toLowerCase()) && (section !== 'Starred' || d.starred));
  const changeZoom = (value: number) => { setFit(false); setZoom(Math.max(10, Math.min(400, value))); };
  const toolRow = (name: string, index: number) => {
    const Icon = icons[name] || FileCheck2;
    const available = name === 'Organize pages' || name === 'Combine files' || name === 'Comment' || name === 'Fill forms';
    const combine = name === 'Combine files';
    const comment = name === 'Comment';
    const forms = name === 'Fill forms';
    const disabled = busy || !available || (combine && documents.length < 2) || ((comment || forms) && !doc);
    return <button key={name} className={s.toolRow} disabled={disabled} onClick={combine ? launchCombine : comment ? launchCommentMode : forms ? launchForms : launchOrganizer} title={combine && documents.length < 2 ? 'Open two PDFs to combine them' : (comment || forms) && !doc ? 'Open a PDF first' : forms ? 'Fill existing fields' : available ? name : `${name} — planned, not implemented yet`}><span className={s.toolIcon} style={{ color: ['#7361b3', '#277bb4', '#239576', '#bc6b25'][index % 4] }}><Icon size={21} strokeWidth={1.7} /></span><span>{name}</span></button>;
  };
  return <div className={`${s.app} ${dark ? s.dark : ''}`}>
    <header className={s.tabbar}>
      <div className={s.appMark}><Files size={21} /></div>
      <button className={s.menuButton} onClick={() => setMenu(v => !v)} aria-expanded={menu}><Menu size={17} /> Menu</button>
      <button className={`${s.homeTab} ${view === 'home' ? s.selectedTab : ''}`} aria-label="Home" onClick={() => setView('home')}><Home size={19} /></button>
      <div className={s.documentTabs}>{documents.map(document => <div key={document.id} className={`${s.documentTab} ${view === 'document' && active === document.id ? s.selectedTab : ''}`}><button disabled={busy} onClick={() => activate(document.id)}><File size={15} /><span>{document.name}{document.dirty ? ' *' : ''}</span></button><IconButton icon={X} label={`Close ${document.name}`} disabled={busy} onClick={() => void close(document.id)} /></div>)}</div>
      <button className={s.createButton} disabled title="Create a PDF — not implemented yet"><Plus size={17} /> Create</button>
      <span className={s.windowTitle}>PDF Workstation</span>
    </header>
    {menu && <div className={s.menuPopover}>
      <button onClick={() => void open()}>Open… <kbd>Ctrl+O</kbd></button><button onClick={() => void open(true)}>Open sample PDF</button>
      <button disabled={!doc || busy} onClick={() => { setMenu(false); void save(); }}>Save a copy… <kbd>Ctrl+S</kbd></button>
      <button onClick={() => { setMenu(false); launchOrganizer(); }}>Organize pages</button>
      <button disabled={!doc || busy} onClick={() => { setMenu(false); setPropertiesOpen(true); }}>Document properties… <kbd>Ctrl+D</kbd></button><hr />
      <button onClick={() => { setDark(v => !v); setMenu(false); }}>Switch to {dark ? 'light' : 'dark'} theme</button>
      <button disabled={busy} onClick={() => { setMenu(false); setUpdatesOpen(true); }}>Check for updates…</button>
      <button disabled={busy} onClick={() => { setMenu(false); setNoticesOpen(true); }}>Third-party notices…</button>
      <button onClick={() => { setNotice('PDF viewing, embedded-text search, Combine Files, Organize Pages, and filling a strict subset of existing plain text fields are available. Rotate, reorder, delete, extract, undo/redo, and save a new copy. Text editing, OCR, and signatures are not implemented yet.'); setMenu(false); }}>About this build</button>
    </div>}
    {updatesOpen && <Updates dirty={documents.some(document => document.dirty)} busy={busy} setBusy={setBusy} close={() => setUpdatesOpen(false)} />}
    {pageTextOpen && doc && <PageText key={`${doc.id}-${doc.revision}-${page}`} document={doc} page={page} close={() => setPageTextOpen(false)} />}
    {passwordRequest && <PasswordDialog key={passwordRequest.challenge.request_id} challenge={passwordRequest.challenge} onOpened={info => { opened(info, passwordRequest.organize); setPasswordRequest(null); }} onClose={() => setPasswordRequest(null)} />}
    {printOpen && doc && <PrintDialog document={doc} page={page} setBusy={setBusy} close={() => setPrintOpen(false)} />}
    {propertiesOpen && doc && <DocumentProperties key={`${doc.id}-${doc.revision}`} document={doc} close={() => setPropertiesOpen(false)} />}
    {noticesOpen && <DependencyNotices close={() => setNoticesOpen(false)} />}
    {combineOpen && <CombineDialog documents={documents} activeId={active} busy={busy} combine={combine} close={() => setCombineOpen(false)} />}
    {insertOpen && <InsertPagesDialog documents={documents} activeId={active} busy={busy} insert={insert} close={() => setInsertOpen(false)} />}
    {replaceOpen && <ReplacePagesDialog documents={documents} activeId={active} initialRange={replaceRange} busy={busy} replace={replace} close={() => setReplaceOpen(false)} />}
    {formsOpen && doc && <FillFormsDialog key={`${doc.id}:${doc.revision}`} document={doc} formFields={formFields} error={formsLoad.request === formsRequest ? formsLoad.error : ''} busy={busy} fill={fillForms} close={() => setFormsOpen(false)} />}
    {commentEditor && doc && <CommentEditor key={`${doc.id}:${doc.revision}:${commentEditor.kind === 'edit' ? commentEditor.annotation.id : 'new'}`} draft={commentEditor} busy={busy} save={contents => commentEditor.kind === 'create-text-highlight'
      ? mutateAnnotation(current => createTextHighlight(current.id, current.revision, commentEditor.page, commentEditor.start, commentEditor.end, contents))
      : commentEditor.kind === 'create' ? commentEditor.type === 'note' ? mutateAnnotation(current => createComment(current.id, current.revision, commentEditor.page, commentEditor.rect, contents || '')) : mutateAnnotation(current => createHighlight(current.id, current.revision, commentEditor.page, commentEditor.rect, contents))
      : commentEditor.annotation.kind === 'note' ? mutateAnnotation(current => updateComment(current.id, current.revision, commentEditor.annotation.id, contents || '')) : mutateAnnotation(current => updateHighlight(current.id, current.revision, commentEditor.annotation.id, contents))}
      remove={commentEditor.kind === 'edit' ? () => commentEditor.annotation.kind === 'note' ? mutateAnnotation(current => deleteComment(current.id, current.revision, commentEditor.annotation.id)) : mutateAnnotation(current => deleteHighlight(current.id, current.revision, commentEditor.annotation.id)) : undefined} close={() => setCommentEditor(null)} />}
    <div className={s.globalbar}>
      <nav className={s.primaryNav}><button className={toolsOpen && view !== 'home' ? s.selectedNav : ''} onClick={() => view === 'document' ? setToolsOpen(v => !v) : setView('tools')}>All tools</button><button disabled>Edit</button><button disabled>Convert</button><button disabled>E-sign</button></nav>
      <div className={s.globalActions}><IconButton icon={Search} label="Find text" disabled={!doc || busy} active={searchOpen} onClick={() => { setView('document'); setOrganizing(false); searchOpen ? closeSearch() : setSearchOpen(true); }} /><span className={s.divider} /><IconButton icon={Undo2} label="Undo" disabled={busy || !doc?.can_undo} onClick={() => void edit({ kind: 'undo' })} /><IconButton icon={Redo2} label="Redo" disabled={busy || !doc?.can_redo} onClick={() => void edit({ kind: 'redo' })} /><IconButton icon={Save} label="Save a copy" disabled={busy || !doc} onClick={() => void save()} /><IconButton icon={Printer} label="Print" disabled={busy || !doc} onClick={() => setPrintOpen(true)} /><IconButton icon={Sun} label="Toggle theme" onClick={() => setDark(v => !v)} /><IconButton icon={CircleHelp} label="Build information" onClick={() => setNotice('Organize Pages and document search are available. Other tools marked unavailable are planned for later milestones. Save a Copy writes a new file and preserves your original.')} /><button className={s.openButton} onClick={() => void open()} disabled={busy}><FolderOpen size={16} /> {busy ? 'Working…' : 'Open a file'}</button></div>
    </div>
    {(error || notice) && <div className={`${s.banner} ${error ? s.error : ''}`} role={error ? 'alert' : 'status'}><span>{error || notice}</span><IconButton icon={X} label="Dismiss message" onClick={() => { setError(''); setNotice(''); }} /></div>}
    <main className={s.main}>
      {view === 'home' ? <>
        <aside className={s.homeSidebar}><h2>Home</h2>{['Recent', 'Starred'].map(item => <button key={item} className={section === item ? s.sidebarSelected : ''} onClick={() => setSection(item)}>{item === 'Recent' ? <Home size={18} /> : <Star size={18} />}{item}</button>)}<div className={s.sidebarCaption}>FILES</div><button onClick={() => void open()}><FolderOpen size={18} /> Your computer</button><div className={s.sidebarBottom}><ShieldCheck size={16} /><span>Local files. Yours to keep.</span></div></aside>
        <section className={s.homeContent}><div className={s.homeHeading}><div><p className={s.eyebrow}>YOUR WORKSPACE</p><h1>Work with your PDFs.</h1></div><button className={s.outlineButton} onClick={() => setView('tools')}>See all tools <ArrowUpRight size={16} /></button></div>
          <div className={s.quickCards}>{['Edit a PDF', 'Export a PDF', 'Combine files', 'Fill forms'].map((name, i) => { const Icon = icons[name]; return <div className={s.quickCard} key={name}><span style={{ color: ['#7260b4', '#2c80b2', '#25876b', '#b86a25'][i] }}><Icon size={29} strokeWidth={1.5} /></span><h3>{name}</h3><p>{['Update text and images.', 'Convert to another format.', 'Bring documents together.', 'Fill supported existing text fields.'][i]}</p><span className={s.planned}>{name === 'Combine files' ? 'Available with two open PDFs' : name === 'Fill forms' ? 'Available with an open PDF' : 'Planned'}</span></div>; })}</div>
          <div className={s.recentHeader}><h2>{section}</h2><div className={s.recentControls}><button className={s.textButton} disabled={!recentFiles.length} onClick={() => setRecentFiles([])}>Clear file history</button><label className={s.search}><Search size={16} /><input aria-label="Search recent files" placeholder="Search your files" value={query} onChange={e => setQuery(e.target.value)} /></label><IconButton icon={List} label="List view" active /></div></div>
          <div className={s.tableHeading}><span>NAME</span><span>LOCATION</span><span>PAGES</span><span /></div>
          {listed.map(file => <div className={s.fileRow} key={file.path}><button disabled={busy} onClick={() => void reopen(file.path)}><FileImage size={25} /><span>{file.name}<small>PDF document</small></span></button><span title={file.path}>This computer</span><span>{file.pages}</span><IconButton icon={Star} label={`${file.starred ? 'Unstar' : 'Star'} ${file.name}`} active={file.starred} onClick={() => setRecentFiles(list => list.map(item => item.path === file.path ? { ...item, starred: !item.starred } : item))} /></div>)}
          {!listed.length && <div className={s.empty}><div className={s.emptyIcon}><Files size={36} strokeWidth={1.25} /></div><h3>{query ? 'No matching files' : section === 'Starred' ? 'Keep important files close' : 'Your documents start here'}</h3><p>{query ? 'Try another file name.' : section === 'Starred' ? 'Star an open file to find it here.' : 'Open a PDF from your computer to start reading.'}</p>{!query && section !== 'Starred' && <><button className={s.openButton} onClick={() => void open()} disabled={busy}>Open a file</button><button className={s.textButton} onClick={() => void open(true)} disabled={busy}>Explore a sample PDF <ChevronRight size={15} /></button></>}</div>}
          <p className={s.foundationNote}>Viewer + Organize Pages · More tools are in development{!native ? ' · Browser preview' : ''}</p>
        </section>
      </> : view === 'tools' ? <section className={s.toolsCatalog}><div className={s.catalogHeading}><div><p className={s.eyebrow}>THE COMPLETE WORKSPACE</p><h1>All tools</h1><p>Combine Files, Organize Pages, and Fill forms are ready. Other advanced tools are planned for later milestones.</p></div><label className={s.search}><Search size={16} /><input aria-label="Search tools" placeholder="Find a tool" value={query} onChange={e => setQuery(e.target.value)} /></label></div>{toolGroups.map(group => <section key={group.name}><h2>{group.name}</h2><div className={s.catalogGrid}>{group.tools.filter(name => name.toLowerCase().includes(query.toLowerCase())).map((name, i) => <div className={s.catalogCard} key={name}>{toolRow(name, i)}<span className={s.planned}>{name === 'Organize pages' || name === 'Combine files' || name === 'Fill forms' ? 'Available' : 'Not available yet'}</span></div>)}</div></section>)}</section> : doc ? <>
        {toolsOpen && <aside className={s.toolsPanel}><div className={s.panelHeading}><h2>All tools</h2><IconButton icon={PanelLeftClose} label="Collapse all tools" onClick={() => setToolsOpen(false)} /></div>{['Export a PDF', 'Edit a PDF', 'Create a PDF', 'Combine files', 'Organize pages', 'Comment', 'Fill forms', 'Scan & OCR', 'Protect a PDF', 'Compress a PDF'].map(toolRow)}<button className={s.textButton} onClick={() => setView('tools')}>View all tools <ChevronRight size={15} /></button><div className={s.panelNote}>Combine Files, Organize Pages, and Fill forms are available. More tools are in development.</div></aside>}
        {organizing ? <Organizer key={doc.id} document={doc} currentPage={page} pageLabels={pageLabels} busy={busy} edit={edit} save={save} split={split} crop={crop} insert={launchInsert} replace={launchReplace} close={() => setOrganizing(false)} /> : <div className={s.documentArea}><Viewer key={`${doc.id}-${doc.revision}`} document={doc} zoom={zoom} fit={fit} target={target} onPage={trackPage} hand={hand} search={activeSearch} annotations={annotations?.status === 'supported' ? annotations.annotations : []} commentMode={commentMode} highlightMode={highlightMode} annotationAvailable={annotations?.status === 'supported'} annotationInteractive={commentMode && !hand && !highlightMode} onCommentCreate={beginComment} onHighlightCreate={beginHighlight} onAnnotationSelect={selectAnnotation} onTextSelection={receiveTextHighlightSelection} /><div className={s.quickToolbar}><IconButton icon={MousePointer2} label="Select text on page" active={!hand && !commentMode && !highlightMode} onClick={() => { setHand(false); setCommentMode(false); setHighlightMode(false); }} /><IconButton icon={Highlighter} label="Highlight selected text" disabled={busy || !textHighlightSelection || annotations?.status !== 'supported'} onPointerDown={captureTextHighlightSelection} onClick={beginTextHighlight} /><IconButton icon={Hand} label="Pan document" active={hand} onClick={() => { setHand(true); setCommentMode(false); setHighlightMode(false); }} /><IconButton icon={Type} label="Read and copy page text" onClick={() => setPageTextOpen(true)} /><span className={s.horizontalDivider} /><IconButton icon={MessageSquare} label="Add comment" active={commentMode} disabled={busy} onClick={launchCommentMode} /><IconButton icon={Highlighter} label="Add area highlight" active={highlightMode} disabled={busy} onClick={launchHighlightMode} /><IconButton icon={Pencil} label="Draw" disabled /><IconButton icon={Type} label="Fill existing fields" disabled={busy} onClick={launchForms} /><IconButton icon={Signature} label="Add signature" disabled /><span className={s.horizontalDivider} /><IconButton icon={MoreHorizontal} label="Customize quick tools" disabled /></div></div>}
        {!organizing && commentsOpen && doc && <CommentsPanel key={`${doc.id}-${doc.revision}`} document={doc} page={page} annotations={annotations} error={annotationsLoad.request === annotationsRequest ? annotationsLoad.error : ''} selectedId={commentEditor?.kind === 'edit' ? commentEditor.annotation.id : null} onAddComment={addCommentOnCurrentPage} onAddHighlight={addHighlightOnCurrentPage} onSelect={selectAnnotation} close={() => setCommentsOpen(false)} />}
        {!organizing && bookmarksOpen && <BookmarksPanel key={`${doc.id}-${doc.revision}`} document={doc} go={go} close={() => setBookmarksOpen(false)} />}
        {!organizing && searchOpen && !bookmarksOpen && <SearchPanel key={`${doc.id}-${doc.revision}`} document={doc} go={go} close={closeSearch} onHighlights={receiveSearch} />}
        {!organizing && nav && !searchOpen && !bookmarksOpen && <aside className={s.pagesPanel}><div className={s.panelHeading}><h2>Pages</h2><IconButton icon={X} label="Close pages" onClick={() => setNav(false)} /></div><button onClick={() => setBookmarksOpen(true)}>Bookmarks</button><div className={s.pageList}>{doc.pages.map((size, i) => { const label = pageLabelFor(pageLabels, i); return <button className={i === page ? s.currentPage : ''} key={i} onClick={() => go(i)}><File size={24} /><span>Page {i + 1}{label !== null && <small style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>Label: {pageLabelDescription(label)}</small>}<small>{(size.width / 72).toFixed(1)} × {(size.height / 72).toFixed(1)} in</small></span></button>; })}</div></aside>}
        <aside className={s.rightRail}><div><IconButton icon={MessageSquare} label="Comments" active={commentsOpen} disabled={busy} onClick={() => { closeSearch(); setBookmarksOpen(false); setOrganizing(false); setCommentsOpen(value => !value); }} /><IconButton icon={Bookmark} label="Bookmarks" active={bookmarksOpen} onClick={() => { closeSearch(); setCommentsOpen(false); setOrganizing(false); setBookmarksOpen(v => !v); }} /><IconButton icon={Files} label="Pages" active={nav && !bookmarksOpen && !searchOpen} onClick={() => { closeSearch(); setCommentsOpen(false); setBookmarksOpen(false); setNav(v => !v); }} /></div><div className={s.pageControls}><IconButton icon={ChevronLeft} label="Previous page" disabled={page === 0} onClick={() => go(page - 1)} /><input aria-label="Page number" key={`${doc.id}-${page}`} type="number" min={1} max={doc.pages.length} defaultValue={page + 1} onKeyDown={e => { if (e.key === 'Enter') go(Number(e.currentTarget.value) - 1); }} onBlur={e => go(Number(e.currentTarget.value) - 1)} /><span className={s.pageCount}>/ {doc.pages.length}</span><IconButton icon={ChevronRight} label="Next page" disabled={page === doc.pages.length - 1} onClick={() => go(page + 1)} /><span className={s.horizontalDivider} /><IconButton icon={RotateCw} label="Rotate view" disabled /><IconButton icon={Maximize} label="Fit width" active={fit} onClick={() => setFit(true)} /><IconButton icon={ZoomIn} label="Zoom in" onClick={() => changeZoom(zoom + 25)} /><IconButton icon={ZoomOut} label="Zoom out" onClick={() => changeZoom(zoom - 25)} /></div></aside>
      </> : null}
    </main>
    <footer className={s.statusbar}><span style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{view === 'document' && doc ? (() => { const currentPage = clampPage(page, doc.pages.length); const label = pageLabelFor(pageLabels, currentPage); return <>Page {currentPage + 1}{label !== null && <> · Label: {pageLabelDescription(label)}</>} · {(doc.pages[currentPage].width / 72).toFixed(2)} × {(doc.pages[currentPage].height / 72).toFixed(2)} in</>; })() : 'PDF Workstation'}</span><span>{busy ? 'Working…' : view === 'document' && doc ? `${doc.name} · ${doc.dirty ? 'Unsaved changes' : 'Source preserved'}` : 'Files stay on your computer'}</span>{view === 'document' ? <select aria-label="Zoom" value={fit ? 'fit' : zoom} onChange={e => e.target.value === 'fit' ? setFit(true) : changeZoom(Number(e.target.value))}><option value="fit">Fit width</option>{Array.from(new Set([10,25,50,75,100,125,150,200,300,400,zoom])).sort((a,b) => a-b).map(z => <option value={z} key={z}>{z}%</option>)}</select> : <span>Local workspace</span>}</footer>
    {pendingClose !== null && <ConfirmDialog title="Discard unsaved page edits?" message="Save a copy before closing to keep your changes. Your original PDF has not been modified." confirmLabel="Discard and close" onCancel={() => setPendingClose(null)} onConfirm={() => { const pending = pendingClose; setPendingClose(null); if (pending === 'window') void getCurrentWindow().destroy(); else void close(pending, true); }} />}
  </div>;
}
