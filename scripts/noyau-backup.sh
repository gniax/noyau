#!/usr/bin/env bash
# Backup Noyau -> NAS (partage SMB backup): noyau/backup/{todo,data,files}; noyau/files = archives deplacees du PC.
#   noyau-backup.sh todo   snapshot horodate des todos si modifiees (timer 15 min)
#   noyau-backup.sh data   archive quotidienne de l'etat .data + miroir des fichiers
# Mot de passe lu depuis NOYAU_BACKUP_PASSWORD_FILE, jamais affiche ni passe en argument.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA="${NOYAU_DATA_DIR:-$ROOT/.data}"
NAS_HOST="${NOYAU_BACKUP_HOST:-nas.lan}"
NAS_SHARE="${NOYAU_BACKUP_SHARE:-backup}"
NAS_USER="${NOYAU_BACKUP_USER:-ia}"
NAS_DIR="${NOYAU_BACKUP_DIR:-noyau}"
PASSWORD_FILE="${NOYAU_BACKUP_PASSWORD_FILE:-$HOME/.config/noyau-backup/password}"
TODO_KEEP_DAYS="${NOYAU_BACKUP_TODO_DAYS:-30}"
DATA_KEEP_DAYS="${NOYAU_BACKUP_DATA_DAYS:-14}"
FILES_KEEP_DAYS="${NOYAU_BACKUP_FILES_DAYS:-30}"
MOUNT="/run/user/$(id -u)/gvfs/smb-share:server=${NAS_HOST},share=${NAS_SHARE},user=${NAS_USER}"
TARGET="$MOUNT/$NAS_DIR"

log() { echo "[$(date '+%F %T')] $*"; }

mount_nas() {
  [[ -d "$MOUNT" ]] && return 0
  [[ -r "$PASSWORD_FILE" ]] || { log "mot de passe introuvable: $PASSWORD_FILE"; exit 1; }
  # gio demande domaine puis mot de passe quand l'utilisateur est dans l'URI.
  { printf 'WORKGROUP\n'; tr -d '\r\n' < "$PASSWORD_FILE"; printf '\n'; } \
    | timeout 30 gio mount "smb://${NAS_USER}@${NAS_HOST}/${NAS_SHARE}" >/dev/null 2>&1 || true
  [[ -d "$MOUNT" ]] || { log "montage SMB refuse pour ${NAS_USER}@${NAS_HOST}/${NAS_SHARE}"; exit 1; }
}

todo_sources() {
  [[ -n "${NOYAU_TODO_FILE:-}" ]] && printf 'main\t%s\n' "$NOYAU_TODO_FILE"
  for file in "$DATA"/profiles/*/"TO DO.md"; do
    [[ -f "$file" ]] && printf '%s\t%s\n' "$(basename "$(dirname "$file")")" "$file"
  done
}

backup_todo() {
  local stamp day profile file dest last
  stamp="$(date '+%Y%m%d-%H%M')"
  day="$(date '+%Y-%m-%d')"
  while IFS=$'\t' read -r profile file; do
    # Une todo vide ou illisible ne doit jamais devenir le dernier snapshot de reference.
    [[ -s "$file" ]] || { log "$profile: todo absente ou vide, ignoree"; continue; }
    dest="$TARGET/backup/todo/$profile"
    mkdir -p "$dest/$day"
    last="$(cat "$dest/.last-sha" 2>/dev/null || true)"
    local sha
    sha="$(sha256sum "$file" | cut -d' ' -f1)"
    [[ "$sha" == "$last" ]] && continue
    cp "$file" "$dest/$day/TO DO-$stamp.md"
    printf '%s\n' "$sha" > "$dest/.last-sha"
    log "$profile: snapshot $day/TO DO-$stamp.md ($(stat -c %s "$file") octets)"
  done < <(todo_sources)
  find "$TARGET/backup/todo" -mindepth 2 -maxdepth 2 -type d -name '20*' -mtime +"$TODO_KEEP_DAYS" -exec rm -rf {} + 2>/dev/null || true
}

backup_data() {
  local stamp archive
  stamp="$(date '+%Y%m%d')"
  mkdir -p "$TARGET/backup/data" "$TARGET/backup/files"
  archive="$(mktemp --suffix=.tar.gz)"
  trap 'rm -f "$archive"' RETURN
  # Modeles et moteurs vocaux se reinstallent; uploads et fichiers projet partent dans le miroir.
  tar -C "$DATA" -czf "$archive" \
    --exclude='./llm' --exclude='./voice' --exclude='./uploads' --exclude='./project-files' --exclude='./project-files-trash' \
    --exclude='./tmp*' --exclude='*/cache' --exclude='*.log' .
  cp "$archive" "$TARGET/backup/data/noyau-data-$stamp.tar.gz.part"
  mv -f "$TARGET/backup/data/noyau-data-$stamp.tar.gz.part" "$TARGET/backup/data/noyau-data-$stamp.tar.gz"
  log "data: noyau-data-$stamp.tar.gz ($(stat -c %s "$archive") octets)"
  find "$TARGET/backup/data" -maxdepth 1 -name 'noyau-data-*.tar.gz' -mtime +"$DATA_KEEP_DAYS" -delete 2>/dev/null || true

  # Miroir: une version remplacee ou supprimee part dans changed/<jour> au lieu d'etre perdue.
  # uploads (pieces jointes du chat, parfois des mots de passe) ne part jamais sur le NAS.
  for dir in project-files; do
    [[ -d "$DATA/$dir" ]] || continue
    # rsync ne cree que le dernier niveau: files/current manque au premier passage.
    mkdir -p "$TARGET/backup/files/current/$dir"
    nice -n 10 ionice -c3 rsync -rt --delete --inplace --no-perms --no-owner --no-group \
      --backup --backup-dir="$TARGET/backup/files/changed/$stamp/$dir" \
      "$DATA/$dir/" "$TARGET/backup/files/current/$dir/"
    log "files: $dir synchronise"
  done
  find "$TARGET/backup/files/changed" -mindepth 1 -maxdepth 1 -type d -mtime +"$FILES_KEEP_DAYS" -exec rm -rf {} + 2>/dev/null || true
}

# Pieces jointes de type mot de passe / passphrase: supprimees 30 min apres l'upload.
# Pieces jointes des chats: secrets evidents shred apres 30 min, petits textes ou noms sensibles apres 24 h, le reste supprime a 7 j.
# ctime = date d'arrivee sur le disque (un zip extrait garde des mtime anciens).
SECRET_WORDS='mdp|pass|pwd|secret|token|credential|sudo'
SENSITIVE_WORDS='key|api|auth|proxy|proxies|client|cookie|seed|mnemonic|private|wallet|acc[eè]s|login|identifiant'
UPLOAD_PURGED=0
UPLOAD_FREED=0

upload_name() {
  # Nom upload: <session>-<id>-<nom d'origine>; seul le nom d'origine compte (fichier sans nom: nom complet).
  basename "$1" | sed -E 's/^noyau-[a-z]+-[a-z0-9]+-[a-z0-9]{4}-[a-z0-9]+-[0-9a-f]{6}-?//'
}

purge_upload() {
  local file="$1" how="$2" size
  size="$(stat -c %s "$file" 2>/dev/null || echo 0)"
  if [[ "$how" == shred ]]; then shred -u "$file" 2>/dev/null || rm -f "$file"; else rm -f "$file"; fi
  [[ -e "$file" ]] && return 0
  UPLOAD_PURGED=$((UPLOAD_PURGED + 1))
  UPLOAD_FREED=$((UPLOAD_FREED + size))
}

clean_secret_uploads() {
  local file name ext size
  local dir="$DATA/uploads"
  [[ -d "$dir" ]] || return 0
  UPLOAD_PURGED=0
  UPLOAD_FREED=0
  while IFS= read -r -d '' file; do
    name="$(upload_name "$file")"
    grep -qiE "$SECRET_WORDS" <<<"$name" || continue
    purge_upload "$file" shred
    log "uploads: secret supprime ($name)"
  done < <(find "$dir" -type f -cmin +30 -print0)
  while IFS= read -r -d '' file; do
    name="$(upload_name "$file")"
    ext="${name##*.}"
    size="$(stat -c %s "$file" 2>/dev/null || echo 0)"
    if [[ "$name" == *.* && "${ext,,}" =~ ^(txt|env|json|pem|key|csv)$ && "$size" -lt 16384 ]] || grep -qiE "$SECRET_WORDS|$SENSITIVE_WORDS" <<<"$name"; then
      purge_upload "$file" shred
    fi
  done < <(find "$dir" -type f -cmin +1440 -print0)
  while IFS= read -r -d '' file; do
    purge_upload "$file" rm
  done < <(find "$dir" -type f -ctime +6 -print0)
  find "$dir" -mindepth 1 -type d -empty -delete 2>/dev/null || true
  (( UPLOAD_PURGED == 0 )) || log "uploads: $UPLOAD_PURGED fichier(s) purge(s), $UPLOAD_FREED octets liberes"
}

case "${1:-}" in
  todo) clean_secret_uploads; mount_nas; backup_todo ;;
  data) clean_secret_uploads; mount_nas; backup_todo; backup_data ;;
  uploads) clean_secret_uploads ;;
  *) echo "usage: $0 todo|data|uploads" >&2; exit 2 ;;
esac
