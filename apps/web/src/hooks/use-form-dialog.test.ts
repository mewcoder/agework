import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useFormDialog } from './use-form-dialog';

describe('useFormDialog', () => {
  it('should initialize with closed state and no target', () => {
    const { result } = renderHook(() => useFormDialog<{ id: string; name: string }>());

    expect(result.current.open).toBe(false);
    expect(result.current.target).toBeUndefined();
    expect(result.current.isEditing).toBe(false);
  });

  it('should open create dialog with no target', () => {
    const { result } = renderHook(() => useFormDialog<{ id: string; name: string }>());

    act(() => {
      result.current.openCreate();
    });

    expect(result.current.open).toBe(true);
    expect(result.current.target).toBeUndefined();
    expect(result.current.isEditing).toBe(false);
  });

  it('should open edit dialog with target', () => {
    const { result } = renderHook(() => useFormDialog<{ id: string; name: string }>());
    const item = { id: '1', name: 'Test Item' };

    act(() => {
      result.current.openEdit(item);
    });

    expect(result.current.open).toBe(true);
    expect(result.current.target).toEqual(item);
    expect(result.current.isEditing).toBe(true);
  });

  it('should close dialog and clear target', () => {
    const { result } = renderHook(() => useFormDialog<{ id: string; name: string }>());
    const item = { id: '1', name: 'Test Item' };

    act(() => {
      result.current.openEdit(item);
    });

    expect(result.current.open).toBe(true);
    expect(result.current.target).toEqual(item);

    act(() => {
      result.current.close();
    });

    expect(result.current.open).toBe(false);
    expect(result.current.target).toBeUndefined();
    expect(result.current.isEditing).toBe(false);
  });

  it('should handle onOpenChange with false', () => {
    const { result } = renderHook(() => useFormDialog<{ id: string; name: string }>());
    const item = { id: '1', name: 'Test Item' };

    act(() => {
      result.current.openEdit(item);
    });

    expect(result.current.open).toBe(true);

    act(() => {
      result.current.onOpenChange(false);
    });

    expect(result.current.open).toBe(false);
    expect(result.current.target).toBeUndefined();
  });

  it('should handle onOpenChange with true', () => {
    const { result } = renderHook(() => useFormDialog<{ id: string; name: string }>());

    act(() => {
      result.current.onOpenChange(true);
    });

    expect(result.current.open).toBe(true);
  });

  it('should switch from create to edit mode', () => {
    const { result } = renderHook(() => useFormDialog<{ id: string; name: string }>());
    const item = { id: '1', name: 'Test Item' };

    act(() => {
      result.current.openCreate();
    });

    expect(result.current.open).toBe(true);
    expect(result.current.isEditing).toBe(false);

    act(() => {
      result.current.openEdit(item);
    });

    expect(result.current.open).toBe(true);
    expect(result.current.isEditing).toBe(true);
    expect(result.current.target).toEqual(item);
  });

  it('should switch from edit to create mode', () => {
    const { result } = renderHook(() => useFormDialog<{ id: string; name: string }>());
    const item = { id: '1', name: 'Test Item' };

    act(() => {
      result.current.openEdit(item);
    });

    expect(result.current.isEditing).toBe(true);

    act(() => {
      result.current.openCreate();
    });

    expect(result.current.open).toBe(true);
    expect(result.current.isEditing).toBe(false);
    expect(result.current.target).toBeUndefined();
  });
});
