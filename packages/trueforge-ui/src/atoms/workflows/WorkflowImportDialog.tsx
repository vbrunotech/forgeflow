'use client';

import { useMemo, useState, type ChangeEvent, type ComponentType } from 'react';

import { auiInputClass } from '../lib/inputClasses.js';
import { Button } from '../primitives/Button.js';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../primitives/Dialog.js';
import { parseWorkflowImport, type WorkflowImport } from './workflowTransfer.js';

export type WorkflowImportDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Explains where the imported workflow goes, e.g. "Adds the steps to this workflow." */
  description: string;
  confirmLabel: string;
  onImport: (result: WorkflowImport) => void;
};

const FORMAT_LABEL: Record<WorkflowImport['format'], string> = { forgeflow: 'Forgeflow', n8n: 'n8n' };

export function WorkflowImportDialog({
  open,
  onOpenChange,
  description,
  confirmLabel,
  onImport,
}: WorkflowImportDialogProps) {
  const [input, setInput] = useState('');
  const [fileError, setFileError] = useState<string | null>(null);

  // Parsing on every change gives a live preview of what will be imported.
  const parsed = useMemo((): { ok: true; value: WorkflowImport } | { ok: false; error: string } | null => {
    if (input.trim() === '') return null;
    try {
      return { ok: true, value: parseWorkflowImport(input) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'Could not read this workflow.' };
    }
  }, [input]);

  const close = (next: boolean) => {
    if (!next) {
      setInput('');
      setFileError(null);
    }
    onOpenChange(next);
  };

  const readFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file === undefined) return;
    file
      .text()
      .then(content => {
        setFileError(null);
        setInput(content);
      })
      .catch(() => setFileError('Could not read that file.'));
  };

  const result = parsed?.ok === true ? parsed.value : null;
  const { manifest } = result?.draft ?? { manifest: null };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Import workflow</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3 px-5">
          <p className="text-sm text-text-secondary">
            {description} Accepts a Forgeflow export or an n8n workflow (exported from n8n, or copied from its canvas).
          </p>
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-text-primary">From a file</span>
            <input
              type="file"
              accept=".json,application/json"
              onChange={readFile}
              className="block text-sm text-text-secondary"
            />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-text-primary">Or paste JSON</span>
            <textarea
              rows={8}
              value={input}
              placeholder='{"nodes": [...], "connections": {...}}'
              onChange={event => setInput(event.target.value)}
              className={auiInputClass('resize-y py-2 font-mono text-xs')}
            />
          </label>
          {fileError != null ? (
            <p role="alert" className="text-sm text-failure-bg">
              {fileError}
            </p>
          ) : null}
          {parsed?.ok === false ? (
            <p role="alert" className="text-sm text-failure-bg">
              {parsed.error}
            </p>
          ) : null}
          {result != null && manifest != null ? (
            <div role="status" className="rounded-md border border-border p-3 text-sm">
              <p className="font-medium text-text-primary">
                {FORMAT_LABEL[result.format]} workflow “{result.draft.name}”: {manifest.nodes.length} step
                {manifest.nodes.length === 1 ? '' : 's'}, {manifest.triggers.length} trigger
                {manifest.triggers.length === 1 ? '' : 's'}
              </p>
              {result.warnings.length > 0 ? (
                <ul className="mt-2 max-h-40 list-disc overflow-y-auto pl-4 text-xs text-text-secondary">
                  {result.warnings.map(warning => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              ) : (
                <p className="mt-1 text-xs text-text-secondary">Everything carries over.</p>
              )}
            </div>
          ) : null}
        </div>
        <DialogFooter>
          <Button.Secondary type="button" size="large" onClick={() => close(false)}>
            Cancel
          </Button.Secondary>
          <Button
            type="button"
            size="large"
            disabled={result == null}
            onClick={() => {
              if (result == null) return;
              onImport(result);
              close(false);
            }}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

declare module '../../theme/SlotsProvider.js' {
  interface AtomSlots {
    WorkflowImportDialog: ComponentType<WorkflowImportDialogProps>;
  }
}
