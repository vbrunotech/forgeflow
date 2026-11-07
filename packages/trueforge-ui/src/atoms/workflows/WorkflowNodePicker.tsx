'use client';

import { useMemo, useState, type ComponentType } from 'react';

import { Icon } from '../../icons/Icon.js';
import { auiButtonClass } from '../lib/buttonClasses.js';
import SearchInput from '../primitives/SearchInput.js';
import { NODE_CATEGORIES, NODE_TYPES, type WorkflowNodeType } from './workflowDraft.js';

export type WorkflowNodePickerProps = {
  onPick: (type: WorkflowNodeType) => void;
  onClose: () => void;
};

const ALL_TYPES = Object.keys(NODE_TYPES).filter((type): type is WorkflowNodeType => Object.hasOwn(NODE_TYPES, type));

export function WorkflowNodePicker({ onPick, onClose }: WorkflowNodePickerProps) {
  const [query, setQuery] = useState('');

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle === '') return ALL_TYPES;
    return ALL_TYPES.filter(type => {
      const info = NODE_TYPES[type];
      return info.label.toLowerCase().includes(needle) || info.description.toLowerCase().includes(needle);
    });
  }, [query]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-2">
        <span className="text-sm font-semibold text-text-primary">Add a step</span>
        <button
          type="button"
          aria-label="Close step picker"
          className={auiButtonClass({ variant: 'ghost', size: 'icon' })}
          onClick={onClose}
        >
          <Icon name="xmark" />
        </button>
      </div>
      <div className="p-3">
        <SearchInput query={query} setQuery={setQuery} placeholder="Search steps" />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
        {matches.length === 0 ? <p className="px-2 py-6 text-sm text-text-secondary">No step matches.</p> : null}
        {NODE_CATEGORIES.map(category => {
          const inCategory = matches.filter(type => NODE_TYPES[type].category === category.id);
          if (inCategory.length === 0) return null;
          return (
            <section key={category.id} aria-label={category.label} className="mb-3">
              <h3 className="px-2 py-1 text-xs font-medium tracking-wide text-text-secondary uppercase">
                {category.label}
              </h3>
              <ul>
                {inCategory.map(type => (
                  <li key={type}>
                    <button
                      type="button"
                      onClick={() => onPick(type)}
                      className="flex w-full items-center gap-3 rounded-md px-2 py-2 text-left hover:bg-secondary-button-hover"
                    >
                      <span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-card-bg">
                        <Icon name={NODE_TYPES[type].icon} className="size-4 text-text-secondary" />
                      </span>
                      <span className="min-w-0">
                        <span className="block text-sm font-medium text-text-primary">{NODE_TYPES[type].label}</span>
                        <span className="block truncate text-xs text-text-secondary">
                          {NODE_TYPES[type].description}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </div>
  );
}

declare module '../../theme/SlotsProvider.js' {
  interface AtomSlots {
    WorkflowNodePicker: ComponentType<WorkflowNodePickerProps>;
  }
}
