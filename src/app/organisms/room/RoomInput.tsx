import React, {
  KeyboardEventHandler,
  RefObject,
  forwardRef,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useAtom } from 'jotai';
import isHotkey from 'is-hotkey';
import { EventType, IContent, MsgType, Room } from 'matrix-js-sdk';
import { ReactEditor } from 'slate-react';
import { Transforms, Editor } from 'slate';
import {
  Box,
  Dialog,
  Icon,
  IconButton,
  Icons,
  Line,
  Overlay,
  OverlayBackdrop,
  OverlayCenter,
  PopOut,
  Scroll,
  Text,
  config,
  toRem,
} from 'folds';
import to from 'await-to-js';

import { useMatrixClient } from '../../hooks/useMatrixClient';
import {
  CustomEditor,
  Toolbar,
  toMatrixCustomHTML,
  toPlainText,
  AUTOCOMPLETE_PREFIXES,
  AutocompletePrefix,
  AutocompleteQuery,
  getAutocompleteQuery,
  getPrevWorldRange,
  resetEditor,
  RoomMentionAutocomplete,
  UserMentionAutocomplete,
  EmoticonAutocomplete,
  createEmoticonElement,
  moveCursor,
  resetEditorHistory,
  customHtmlEqualsPlainText,
  trimCustomHtml,
  isEmptyEditor,
  getBeginCommand,
  trimCommand,
} from '../../components/editor';
import { EmojiBoard, EmojiBoardTab } from '../../components/emoji-board';
import { UseStateProvider } from '../../components/UseStateProvider';
import initMatrix from '../../../client/initMatrix';
import { TUploadContent, encryptFile, getImageInfo } from '../../utils/matrix';
import { useTypingStatusUpdater } from '../../hooks/useTypingStatusUpdater';
import { useFilePicker } from '../../hooks/useFilePicker';
import { useFilePasteHandler } from '../../hooks/useFilePasteHandler';
import { useFileDropZone } from '../../hooks/useFileDrop';
import {
  TUploadItem,
  roomIdToMsgDraftAtomFamily,
  roomIdToReplyDraftAtomFamily,
  roomIdToUploadItemsAtomFamily,
  roomUploadAtomFamily,
} from '../../state/roomInputDrafts';
import { UploadCardRenderer } from '../../components/upload-card';
import {
  UploadBoard,
  UploadBoardContent,
  UploadBoardHeader,
  UploadBoardImperativeHandlers,
} from '../../components/upload-board';
import {
  Upload,
  UploadStatus,
  UploadSuccess,
  createUploadFamilyObserverAtom,
} from '../../state/upload';
import { getImageUrlBlob, loadImageElement } from '../../utils/dom';
import { safeFile } from '../../utils/mimeTypes';
import { fulfilledPromiseSettledResult } from '../../utils/common';
import { useSetting } from '../../state/hooks/settings';
import { settingsAtom } from '../../state/settings';
import {
  getAudioMsgContent,
  getFileMsgContent,
  getImageMsgContent,
  getVideoMsgContent,
} from './msgContent';
import { MessageReply } from '../../molecules/message/Message';
import colorMXID from '../../../util/colorMXID';
import {
  parseReplyBody,
  parseReplyFormattedBody,
  trimReplyFromBody,
  trimReplyFromFormattedBody,
} from '../../utils/room';
import { sanitizeText } from '../../utils/sanitize';
import { useScreenSize } from '../../hooks/useScreenSize';
import { CommandAutocomplete } from './CommandAutocomplete';
import { Command, SHRUG, useCommands } from '../../hooks/useCommands';
import { mobileOrTablet } from '../../utils/user-agent';

interface RoomInputProps {
  editor: Editor;
  roomViewRef: RefObject<HTMLElement>;
  roomId: string;
  room: Room;
}
export const RoomInput = forwardRef<HTMLDivElement, RoomInputProps>(
  ({ editor, roomViewRef, roomId, room }, ref) => {
    const mx = useMatrixClient();
    const [enterForNewline] = useSetting(settingsAtom, 'enterForNewline');
    const [isMarkdown] = useSetting(settingsAtom, 'isMarkdown');
    const commands = useCommands(mx, room);

    const [msgDraft, setMsgDraft] = useAtom(roomIdToMsgDraftAtomFamily(roomId));
    const [replyDraft, setReplyDraft] = useAtom(roomIdToReplyDraftAtomFamily(roomId));
    const [uploadBoard, setUploadBoard] = useState(true);
    const [selectedFiles, setSelectedFiles] = useAtom(roomIdToUploadItemsAtomFamily(roomId));
    const uploadFamilyObserverAtom = createUploadFamilyObserverAtom(
      roomUploadAtomFamily,
      selectedFiles.map((f) => f.file)
    );
    const uploadBoardHandlers = useRef<UploadBoardImperativeHandlers>();

    const imagePackRooms: Room[] = useMemo(() => {
      const allParentSpaces = [roomId, ...(initMatrix.roomList?.getAllParentSpaces(roomId) ?? [])];
      return allParentSpaces.reduce<Room[]>((list, rId) => {
        const r = mx.getRoom(rId);
        if (r) list.push(r);
        return list;
      }, []);
    }, [mx, roomId]);

    const [toolbar, setToolbar] = useSetting(settingsAtom, 'editorToolbar');
    const [autocompleteQuery, setAutocompleteQuery] =
      useState<AutocompleteQuery<AutocompletePrefix>>();

    const sendTypingStatus = useTypingStatusUpdater(mx, roomId);

    const handleFiles = useCallback(
      async (files: File[]) => {
        setUploadBoard(true);
        const safeFiles = files.map(safeFile);
        const fileItems: TUploadItem[] = [];

        if (mx.isRoomEncrypted(roomId)) {
          const encryptFiles = fulfilledPromiseSettledResult(
            await Promise.allSettled(safeFiles.map((f) => encryptFile(f)))
          );
          encryptFiles.forEach((ef) => fileItems.push(ef));
        } else {
          safeFiles.forEach((f) =>
            fileItems.push({ file: f, originalFile: f, encInfo: undefined })
          );
        }
        setSelectedFiles({
          type: 'PUT',
          item: fileItems,
        });
      },
      [setSelectedFiles, roomId, mx]
    );
    const pickFile = useFilePicker(handleFiles, true);
    const handlePaste = useFilePasteHandler(handleFiles);
    const dropZoneVisible = useFileDropZone(roomViewRef, handleFiles);

    const [, screenWidth] = useScreenSize();
    const hideStickerBtn = screenWidth < 500;

    useEffect(() => {
      Transforms.insertFragment(editor, msgDraft);
    }, [editor, msgDraft]);

    useEffect(() => {
      if (!mobileOrTablet()) ReactEditor.focus(editor);
      return () => {
        if (!isEmptyEditor(editor)) {
          const parsedDraft = JSON.parse(JSON.stringify(editor.children));
          setMsgDraft(parsedDraft);
        } else {
          roomIdToMsgDraftAtomFamily.remove(roomId);
        }
        resetEditor(editor);
        resetEditorHistory(editor);
      };
    }, [roomId, editor, setMsgDraft]);

    const handleRemoveUpload = useCallback(
      (upload: TUploadContent | TUploadContent[]) => {
        const uploads = Array.isArray(upload) ? upload : [upload];
        setSelectedFiles({
          type: 'DELETE',
          item: selectedFiles.filter((f) => uploads.find((u) => u === f.file)),
        });
        uploads.forEach((u) => roomUploadAtomFamily.remove(u));
      },
      [setSelectedFiles, selectedFiles]
    );

    const handleCancelUpload = (uploads: Upload[]) => {
      uploads.forEach((upload) => {
        if (upload.status === UploadStatus.Loading) {
          mx.cancelUpload(upload.promise);
        }
      });
      handleRemoveUpload(uploads.map((upload) => upload.file));
    };

    const handleSendUpload = async (uploads: UploadSuccess[]) => {
      const sendPromises = uploads.map(async (upload) => {
        const fileItem = selectedFiles.find((f) => f.file === upload.file);
        if (fileItem && fileItem.file.type.startsWith('image')) {
          const [imgError, imgContent] = await to(getImageMsgContent(mx, fileItem, upload.mxc));
          if (imgError) console.warn(imgError);
          if (imgContent) mx.sendMessage(roomId, imgContent);
          return;
        }
        if (fileItem && fileItem.file.type.startsWith('video')) {
          const [videoError, videoContent] = await to(getVideoMsgContent(mx, fileItem, upload.mxc));
          if (videoError) console.warn(videoError);
          if (videoContent) mx.sendMessage(roomId, videoContent);
          return;
        }
        if (fileItem && fileItem.file.type.startsWith('audio')) {
          mx.sendMessage(roomId, getAudioMsgContent(fileItem, upload.mxc));
          return;
        }
        if (fileItem) {
          mx.sendMessage(roomId, getFileMsgContent(fileItem, upload.mxc));
        }
      });
      handleCancelUpload(uploads);
      await Promise.allSettled(sendPromises);
    };

    const submit = useCallback(() => {
      uploadBoardHandlers.current?.handleSend();

      const commandName = getBeginCommand(editor);

      let plainText = toPlainText(editor.children).trim();
      let customHtml = trimCustomHtml(
        toMatrixCustomHTML(editor.children, {
          allowTextFormatting: true,
          allowMarkdown: isMarkdown,
        })
      );
      let msgType = MsgType.Text;

      if (commandName) {
        plainText = trimCommand(commandName, plainText);
        customHtml = trimCommand(commandName, customHtml);
      }
      if (commandName === Command.Me) {
        msgType = MsgType.Emote;
      } else if (commandName === Command.Notice) {
        msgType = MsgType.Notice;
      } else if (commandName === Command.Shrug) {
        plainText = `${SHRUG} ${plainText}`;
        customHtml = `${SHRUG} ${customHtml}`;
      } else if (commandName) {
        const commandContent = commands[commandName as Command];
        if (commandContent) {
          commandContent.exe(plainText);
        }
        resetEditor(editor);
        resetEditorHistory(editor);
        sendTypingStatus(false);
        return;
      }

      if (plainText === '') return;

      let body = plainText;
      let formattedBody = customHtml;
      if (replyDraft) {
        body = parseReplyBody(replyDraft.userId, trimReplyFromBody(replyDraft.body)) + body;
        formattedBody =
          parseReplyFormattedBody(
            roomId,
            replyDraft.userId,
            replyDraft.eventId,
            replyDraft.formattedBody
              ? trimReplyFromFormattedBody(replyDraft.formattedBody)
              : sanitizeText(replyDraft.body)
          ) + formattedBody;
      }

      const content: IContent = {
        msgtype: msgType,
        body,
      };
      if (replyDraft || !customHtmlEqualsPlainText(formattedBody, body)) {
        content.format = 'org.matrix.custom.html';
        content.formatted_body = formattedBody;
      }
      if (replyDraft) {
        content['m.relates_to'] = {
          'm.in_reply_to': {
            event_id: replyDraft.eventId,
          },
        };
      }
      mx.sendMessage(roomId, content);
      resetEditor(editor);
      resetEditorHistory(editor);
      setReplyDraft();
      sendTypingStatus(false);
    }, [mx, roomId, editor, replyDraft, sendTypingStatus, setReplyDraft, isMarkdown, commands]);

    const handleKeyDown: KeyboardEventHandler = useCallback(
      (evt) => {
        if (enterForNewline ? isHotkey('shift+enter', evt) : isHotkey('enter', evt)) {
          evt.preventDefault();
          submit();
        }
        if (isHotkey('escape', evt)) {
          evt.preventDefault();
          setReplyDraft();
        }
      },
      [submit, setReplyDraft, enterForNewline]
    );

    const handleKeyUp: KeyboardEventHandler = useCallback(
      (evt) => {
        if (isHotkey('escape', evt)) {
          evt.preventDefault();
          return;
        }

        sendTypingStatus(!isEmptyEditor(editor));

        const prevWordRange = getPrevWorldRange(editor);
        const query = prevWordRange
          ? getAutocompleteQuery<AutocompletePrefix>(editor, prevWordRange, AUTOCOMPLETE_PREFIXES)
          : undefined;
        setAutocompleteQuery(query);
      },
      [editor, sendTypingStatus]
    );

    const handleCloseAutocomplete = useCallback(() => {
      setAutocompleteQuery(undefined);
      ReactEditor.focus(editor);
    }, [editor]);

    const handleEmoticonSelect = (key: string, shortcode: string) => {
      editor.insertNode(createEmoticonElement(key, shortcode));
      moveCursor(editor);
    };

    const handleStickerSelect = async (mxc: string, shortcode: string) => {
      const stickerUrl = mx.mxcUrlToHttp(mxc);
      if (!stickerUrl) return;

      const info = await getImageInfo(
        await loadImageElement(stickerUrl),
        await getImageUrlBlob(stickerUrl)
      );

      mx.sendEvent(roomId, EventType.Sticker, {
        body: shortcode,
        url: mxc,
        info,
      });
    };

    return (
      <div ref={ref}>
        {selectedFiles.length > 0 && (
          <UploadBoard
            header={
              <UploadBoardHeader
                open={uploadBoard}
                onToggle={() => setUploadBoard(!uploadBoard)}
                uploadFamilyObserverAtom={uploadFamilyObserverAtom}
                onSend={handleSendUpload}
                imperativeHandlerRef={uploadBoardHandlers}
                onCancel={handleCancelUpload}
              />
            }
          >
            {uploadBoard && (
              <Scroll size="300" hideTrack visibility="Hover">
                <UploadBoardContent>
                  {Array.from(selectedFiles)
                    .reverse()
                    .map((fileItem, index) => (
                      <UploadCardRenderer
                        // eslint-disable-next-line react/no-array-index-key
                        key={index}
                        file={fileItem.file}
                        isEncrypted={!!fileItem.encInfo}
                        uploadAtom={roomUploadAtomFamily(fileItem.file)}
                        onRemove={handleRemoveUpload}
                      />
                    ))}
                </UploadBoardContent>
              </Scroll>
            )}
          </UploadBoard>
        )}
        <Overlay
          open={dropZoneVisible}
          backdrop={<OverlayBackdrop />}
          style={{ pointerEvents: 'none' }}
        >
          <OverlayCenter>
            <Dialog variant="Primary">
              <Box
                direction="Column"
                justifyContent="Center"
                alignItems="Center"
                gap="500"
                style={{ padding: toRem(60) }}
              >
                <Icon size="600" src={Icons.File} />
                <Text size="H4" align="Center">
                  {`Drop Files in "${room?.name || 'Room'}"`}
                </Text>
                <Text align="Center">Drag and drop files here or click for selection dialog</Text>
              </Box>
            </Dialog>
          </OverlayCenter>
        </Overlay>
        {autocompleteQuery?.prefix === AutocompletePrefix.RoomMention && (
          <RoomMentionAutocomplete
            roomId={roomId}
            editor={editor}
            query={autocompleteQuery}
            requestClose={handleCloseAutocomplete}
          />
        )}
        {autocompleteQuery?.prefix === AutocompletePrefix.UserMention && (
          <UserMentionAutocomplete
            room={room}
            editor={editor}
            query={autocompleteQuery}
            requestClose={handleCloseAutocomplete}
          />
        )}
        {autocompleteQuery?.prefix === AutocompletePrefix.Emoticon && (
          <EmoticonAutocomplete
            imagePackRooms={imagePackRooms}
            editor={editor}
            query={autocompleteQuery}
            requestClose={handleCloseAutocomplete}
          />
        )}
        {autocompleteQuery?.prefix === AutocompletePrefix.Command && (
          <CommandAutocomplete
            room={room}
            editor={editor}
            query={autocompleteQuery}
            requestClose={handleCloseAutocomplete}
          />
        )}
        <CustomEditor
          editableName="RoomInput"
          editor={editor}
          placeholder="Send a message..."
          onKeyDown={handleKeyDown}
          onKeyUp={handleKeyUp}
          onPaste={handlePaste}
          top={
            replyDraft && (
              <div>
                <Box
                  alignItems="Center"
                  gap="300"
                  style={{ padding: `${config.space.S200} ${config.space.S300} 0` }}
                >
                  <IconButton
                    onClick={() => setReplyDraft()}
                    variant="SurfaceVariant"
                    size="300"
                    radii="300"
                  >
                    <Icon src={Icons.Cross} size="50" />
                  </IconButton>
                  <MessageReply
                    color={colorMXID(replyDraft.userId)}
                    name={room?.getMember(replyDraft.userId)?.name ?? replyDraft.userId}
                    body={replyDraft.body}
                  />
                </Box>
              </div>
            )
          }
          before={
            <IconButton
              onClick={() => pickFile('*')}
              variant="SurfaceVariant"
              size="300"
              radii="300"
            >
              <Icon src={Icons.PlusCircle} />
            </IconButton>
          }
          after={
            <>
              <IconButton
                variant="SurfaceVariant"
                size="300"
                radii="300"
                onClick={() => setToolbar(!toolbar)}
              >
                <Icon src={toolbar ? Icons.AlphabetUnderline : Icons.Alphabet} />
              </IconButton>
              <UseStateProvider initial={undefined}>
                {(emojiBoardTab: EmojiBoardTab | undefined, setEmojiBoardTab) => (
                  <PopOut
                    offset={16}
                    alignOffset={-44}
                    position="Top"
                    align="End"
                    open={!!emojiBoardTab}
                    content={
                      <EmojiBoard
                        tab={emojiBoardTab}
                        onTabChange={setEmojiBoardTab}
                        imagePackRooms={imagePackRooms}
                        returnFocusOnDeactivate={false}
                        onEmojiSelect={handleEmoticonSelect}
                        onCustomEmojiSelect={handleEmoticonSelect}
                        onStickerSelect={handleStickerSelect}
                        requestClose={() => {
                          setEmojiBoardTab(undefined);
                          if (!mobileOrTablet()) ReactEditor.focus(editor);
                        }}
                      />
                    }
                  >
                    {(anchorRef) => (
                      <>
                        {!hideStickerBtn && (
                          <IconButton
                            aria-pressed={emojiBoardTab === EmojiBoardTab.Sticker}
                            onClick={() => setEmojiBoardTab(EmojiBoardTab.Sticker)}
                            variant="SurfaceVariant"
                            size="300"
                            radii="300"
                          >
                            <Icon
                              src={Icons.Sticker}
                              filled={emojiBoardTab === EmojiBoardTab.Sticker}
                            />
                          </IconButton>
                        )}
                        <IconButton
                          ref={anchorRef}
                          aria-pressed={
                            hideStickerBtn ? !!emojiBoardTab : emojiBoardTab === EmojiBoardTab.Emoji
                          }
                          onClick={() => setEmojiBoardTab(EmojiBoardTab.Emoji)}
                          variant="SurfaceVariant"
                          size="300"
                          radii="300"
                        >
                          <Icon
                            src={Icons.Smile}
                            filled={
                              hideStickerBtn
                                ? !!emojiBoardTab
                                : emojiBoardTab === EmojiBoardTab.Emoji
                            }
                          />
                        </IconButton>
                      </>
                    )}
                  </PopOut>
                )}
              </UseStateProvider>
              <IconButton onClick={submit} variant="SurfaceVariant" size="300" radii="300">
                <Icon src={Icons.Send} />
              </IconButton>
            </>
          }
          bottom={
            toolbar && (
              <div>
                <Line variant="SurfaceVariant" size="300" />
                <Toolbar />
              </div>
            )
          }
        />
      </div>
    );
  }
);
