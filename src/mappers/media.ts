export interface MappedFile {
  file_id: number;
  size: number;
  local_path: string | null;
  is_downloaded: boolean;
}

export function mapFile(file: Record<string, any>): MappedFile {
  return {
    file_id: file.id,
    size: file.size ?? file.expected_size ?? 0,
    local_path: file.local?.path || null,
    is_downloaded: file.local?.is_downloading_completed ?? false,
  };
}
