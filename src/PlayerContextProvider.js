import React, { Component, Fragment, createElement } from 'react';
import PropTypes from 'prop-types';
import arrayFindIndex from 'array-find-index';

import PlayerContext from './PlayerContext';
import GroupContext from './GroupContext';
import * as PlayerPropTypes from './PlayerPropTypes';
import createCustomAudioElement from './factories/createCustomAudioElement';
import ShuffleManager from './utils/ShuffleManager';
import { getStateSnapshot, restoreStateFromSnapshot } from './utils/snapshot';
import getSourceList from './utils/getSourceList';
import getTrackSources from './utils/getTrackSources';
import findTrackIndexByUrl from './utils/findTrackIndexByUrl';
import isPlaylistValid from './utils/isPlaylistValid';
import getRepeatStrategy from './utils/getRepeatStrategy';
import convertToNumberWithinIntervalBounds from './utils/convertToNumberWithinIntervalBounds';
import streamVideoElementToCanvas from './utils/streamVideoElementToCanvas';
import { logError, logWarning } from './utils/console';
import { repeatStrategyOptions } from './constants';

function playErrorHandler(err) {
  logError(err);
  if (err.name === 'NotAllowedError') {
    const warningMessage =
      'Audio playback failed at ' +
      new Date().toLocaleTimeString() +
      '! (Perhaps autoplay is disabled in this browser.)';
    logWarning(warningMessage);
  }
}

// Existing Media Session API implementations have default handlers
// for play/pause, and may yield unexpected behavior if custom
// play/pause handlers are defined - so let's leave them be.
const supportableMediaSessionActions = [
  'previoustrack',
  'nexttrack',
  'seekbackward',
  'seekforward'
];

// media element readyState
const HAVE_NOTHING = 0;

const defaultState = {
  // indicates whether audio player should be paused
  paused: true,
  // elapsed time for active track, in seconds
  currentTime: 0,
  // The most recent targeted time, in seconds, for seek preview
  seekPreviewTime: 0,
  /* true if the user is currently dragging the mouse
   * to seek a new track position
   */
  seekInProgress: false,
  /* true if audio was playing when seek previewing began,
   * it was paused, and it should be resumed on seek
   * complete
   */
  awaitingResumeOnSeekComplete: false,
  // the duration in seconds of the loaded track
  duration: 0,
  /* the TimeRanges object representing the buffered sections of the
   * loaded track
   */
  buffered: null,
  /* the TimeRanges object representing the played sections of the
   * loaded track
   */
  played: null,
  // true if the audio is currently stalled pending data buffering
  stalled: false,
  // true if the active track should play on the next componentDidUpdate
  awaitingPlay: false
};

// assumes playlist is valid
function getGoToTrackState(prevState, index, shouldPlay = true) {
  const isNewTrack = prevState.activeTrackIndex !== index;
  return {
    activeTrackIndex: index,
    trackLoading: isNewTrack,
    currentTime: 0,
    loop: isNewTrack ? false : prevState.loop,
    awaitingPlay: Boolean(shouldPlay),
    paused: !shouldPlay
  };
}

class PlayerContextProvider extends Component {
  constructor(props) {
    super(props);

    this.state = {
      ...defaultState,
      // index matching requested track (whether track has loaded or not)
      activeTrackIndex: convertToNumberWithinIntervalBounds(
        props.startingTrackIndex,
        0
      ),
      // whether we're waiting on loading metadata for the active track
      trackLoading: isPlaylistValid(props.playlist),
      // the current timestamp on the active track in seconds
      currentTime: convertToNumberWithinIntervalBounds(props.startingTime, 0),
      // the latest volume of the audio, between 0 and 1.
      volume: convertToNumberWithinIntervalBounds(props.defaultVolume, 0, 1),
      // true if the audio has been muted
      muted: props.defaultMuted,
      // whether to loop the active track
      loop: props.defaultRepeatStrategy === 'track',
      // true if playlist should continue at start after completion
      cycle: props.defaultRepeatStrategy === 'playlist',
      // whether to randomly pick next track from playlist after one finishes
      shuffle: props.defaultShuffle,
      // Rate at which audio should be played. 1.0 is normal speed.
      playbackRate: props.defaultPlaybackRate,
      // true if user is currently dragging mouse to change the volume
      setVolumeInProgress: false,
      // initialize awaitingPlay from autoplay prop
      awaitingPlay: props.autoplay && isPlaylistValid(props.playlist),
      // playlist prop copied to state (for getDerivedStateFromProps)
      __playlist__: props.playlist,
      // load overrides from previously-captured state snapshot
      ...(props.initialStateSnapshot
        ? restoreStateFromSnapshot(props.initialStateSnapshot, props)
        : {})
    };

    // volume at last time we were unmuted and not actively setting volume
    this.lastStableVolume = this.state.volume;

    // used to keep track of play history when we are shuffling
    this.shuffler = new ShuffleManager(getSourceList(props.playlist), {
      allowBackShuffle: props.allowBackShuffle
    });

    // html audio element used for playback
    this.audio = null;

    this.setAudioElementRef = this.setAudioElementRef.bind(this);

    // bind callback methods to pass to descendant elements
    this.togglePause = this.togglePause.bind(this);
    this.selectTrackIndex = this.selectTrackIndex.bind(this);
    this.forwardSkip = this.forwardSkip.bind(this);
    this.backSkip = this.backSkip.bind(this);
    this.seekPreview = this.seekPreview.bind(this);
    this.seekComplete = this.seekComplete.bind(this);
    this.setVolume = this.setVolume.bind(this);
    this.setVolumeComplete = this.setVolumeComplete.bind(this);
    this.toggleMuted = this.toggleMuted.bind(this);
    this.toggleShuffle = this.toggleShuffle.bind(this);
    this.setRepeatStrategy = this.setRepeatStrategy.bind(this);
    this.setPlaybackRate = this.setPlaybackRate.bind(this);
    this.pipeVideoStreamToCanvas = this.pipeVideoStreamToCanvas.bind(this);

    // bind audio event handlers
    this.handleAudioPlay = this.handleAudioPlay.bind(this);
    this.handleAudioPause = this.handleAudioPause.bind(this);
    this.handleAudioSrcrequest = this.handleAudioSrcrequest.bind(this);
    this.handleAudioEnded = this.handleAudioEnded.bind(this);
    this.handleAudioStalled = this.handleAudioStalled.bind(this);
    this.handleAudioCanplaythrough = this.handleAudioCanplaythrough.bind(this);
    this.handleAudioTimeupdate = this.handleAudioTimeupdate.bind(this);
    this.handleAudioLoadedmetadata = this.handleAudioLoadedmetadata.bind(this);
    this.handleAudioVolumechange = this.handleAudioVolumechange.bind(this);
    this.handleAudioDurationchange = this.handleAudioDurationchange.bind(this);
    this.handleAudioProgress = this.handleAudioProgress.bind(this);
    this.handleAudioLoopchange = this.handleAudioLoopchange.bind(this);
    this.handleAudioRatechange = this.handleAudioRatechange.bind(this);
  }

  componentDidMount() {
    const audio = (this.audio = createCustomAudioElement(this.audio));

    // initialize audio properties
    if (audio.readyState !== HAVE_NOTHING) {
      // we only set the currentTime now if we're beyond the
      // HAVE_NOTHING readyState. Otherwise we'll let this get
      // set when the loadedmetadata event fires. This avoids
      // an issue where some browsers ignore or delay currentTime
      // updates when in the HAVE_NOTHING state.
      audio.currentTime = this.state.currentTime;
    }
    audio.volume = this.state.volume;
    audio.muted = this.state.muted;
    audio.defaultPlaybackRate = this.props.defaultPlaybackRate;
    audio.playbackRate = this.state.playbackRate;

    // add special event listeners on the audio element
    audio.addEventListener('srcrequest', this.handleAudioSrcrequest);
    audio.addEventListener('loopchange', this.handleAudioLoopchange);

    if (this.state.awaitingPlay) {
      this.setState({
        awaitingPlay: false
      });
      this.delayTimeout = setTimeout(() => {
        this.togglePause(false);
      }, this.props.autoplayDelayInSeconds * 1000);
    }
  }

  static getDerivedStateFromProps(nextProps, prevState) {
    const newPlaylist = nextProps.playlist;

    const baseNewState = {
      __playlist__: newPlaylist
    };

    // check if the new playlist is invalid
    if (!isPlaylistValid(newPlaylist)) {
      return {
        ...defaultState,
        ...baseNewState,
        activeTrackIndex: 0,
        trackLoading: false
      };
    }

    // check if the activeTrackIndex doesn't need to be updated
    const prevSources = getTrackSources(
      prevState.__playlist__,
      prevState.activeTrackIndex
    );
    // the sources if we stay on the same track index
    const currentSources = getTrackSources(
      newPlaylist,
      prevState.activeTrackIndex
    );
    // non-comprehensive but probably accurate check
    if (prevSources[0].src === currentSources[0].src) {
      // our active track index already matches
      return baseNewState;
    }

    /* if the track we're already playing is in the new playlist, update the
     * activeTrackIndex.
     */
    const newTrackIndex = findTrackIndexByUrl(newPlaylist, prevSources[0].src);
    if (newTrackIndex !== -1) {
      return {
        ...baseNewState,
        activeTrackIndex: newTrackIndex
      };
    }

    // if not, then load the first track in the new playlist, and pause.
    return {
      ...baseNewState,
      ...getGoToTrackState(prevState, 0, false)
    };
  }

  componentDidUpdate(prevProps, prevState) {
    this.audio.defaultPlaybackRate = this.props.defaultPlaybackRate;

    this.shuffler.setList(getSourceList(this.props.playlist));
    this.shuffler.setOptions({
      allowBackShuffle: this.props.allowBackShuffle
    });

    const prevSources = getTrackSources(
      prevProps.playlist,
      prevState.activeTrackIndex
    );
    const newSources = getTrackSources(
      this.props.playlist,
      this.state.activeTrackIndex
    );
    if (prevSources[0].src !== newSources[0].src) {
      // cancel playback and re-scan current sources
      this.audio.load();

      if (!this.state.shuffle) {
        // after toggling off shuffle, we defer clearing the shuffle
        // history until we actually change tracks - if the user quickly
        // toggles  shuffle off then back on again, we don't want to have
        // lost our history.
        this.shuffler.clear();
      }
    }

    if (prevProps !== this.props && !this.audio.paused) {
      // update running media session based on new props
      this.stealMediaSession();
    }

    if (this.state.awaitingPlay) {
      this.setState({
        awaitingPlay: false
      });
      // audio.currentSrc is updated asynchronously so we should
      // play async to avoid weird intermediate state issues
      setTimeout(() => {
        this.togglePause(false);
      });
    }

    clearTimeout(this.snapshotUpdateTimeout);
    this.snapshotUpdateTimeout = setTimeout(() => {
      if (this.props.onStateSnapshot) {
        this.props.onStateSnapshot(getStateSnapshot(this.state));
      }
    }, 100);
  }

  componentWillUnmount() {
    const { audio } = this;
    // remove special event listeners on the audio element
    audio.removeEventListener('srcrequest', this.handleAudioSrcrequest);
    audio.removeEventListener('loopchange', this.handleAudioLoopchange);

    clearTimeout(this.gapLengthTimeout);
    clearTimeout(this.delayTimeout);
  }

  setAudioElementRef(ref) {
    this.audio = ref;
    if (typeof this.props.audioElementRef === 'function') {
      this.props.audioElementRef(ref);
    }
  }

  stealMediaSession() {
    if (
      // eslint-disable-next-line no-undef
      !(window.MediaSession && navigator.mediaSession instanceof MediaSession)
    ) {
      return;
    }
    // eslint-disable-next-line no-undef
    navigator.mediaSession.metadata = new MediaMetadata(
      this.props.playlist[this.state.activeTrackIndex]
    );
    supportableMediaSessionActions
      .map(action => {
        if (this.props.supportedMediaSessionActions.indexOf(action) === -1) {
          return null;
        }
        const seekLength = this.props.mediaSessionSeekLengthInSeconds;
        switch (action) {
          case 'play':
            return this.togglePause.bind(this, false);
          case 'pause':
            return this.togglePause.bind(this, true);
          case 'previoustrack':
            return this.backSkip;
          case 'nexttrack':
            return this.forwardSkip;
          case 'seekbackward':
            return () => (this.audio.currentTime -= seekLength);
          case 'seekforward':
            return () => (this.audio.currentTime += seekLength);
          default:
            return undefined;
        }
      })
      .forEach((handler, i) => {
        navigator.mediaSession.setActionHandler(
          supportableMediaSessionActions[i],
          handler
        );
      });
  }

  pipeVideoStreamToCanvas(canvas, callback) {
    return streamVideoElementToCanvas(this.audio, canvas, callback);
  }

  handleAudioPlay() {
    this.setState(state => (state.paused === false ? null : { paused: false }));
    this.stealMediaSession();
  }

  handleAudioPause() {
    this.setState(state => (state.paused === true ? null : { paused: true }));
  }

  handleAudioSrcrequest(e) {
    const { playlist } = this.props;
    const sources = getTrackSources(playlist, this.state.activeTrackIndex);
    if (arrayFindIndex(sources, s => s.src === e.srcRequested) !== -1) {
      // we're good! nothing to update.
      return;
    }
    // looks like 'src' was set from outside our component.
    // let's see if we can use it.
    const newTrackIndex = findTrackIndexByUrl(playlist, e.srcRequested);
    if (newTrackIndex === -1) {
      logError(
        `Source '${e.srcRequested}' does not exist in the loaded playlist. ` +
          `Make sure you've updated the 'playlist' prop to ` +
          `PlayerContextProvider before you select this track!`
      );
      return;
    }
    this.selectTrackIndex(newTrackIndex);
  }

  handleAudioEnded() {
    clearTimeout(this.gapLengthTimeout);
    const { playlist, loadFirstTrackOnPlaylistComplete } = this.props;
    if (!isPlaylistValid(playlist)) {
      return;
    }
    const { cycle, activeTrackIndex } = this.state;
    if (!cycle && activeTrackIndex + 1 >= playlist.length) {
      if (loadFirstTrackOnPlaylistComplete) {
        this.goToTrack(0, false);
      }
      return;
    }
    this.gapLengthTimeout = setTimeout(
      this.forwardSkip,
      this.props.gapLengthInSeconds * 1000
    );
  }

  handleAudioStalled() {
    this.setState(state => (state.stalled === true ? null : { stalled: true }));
  }

  handleAudioCanplaythrough() {
    this.setState(
      state => (state.stalled === false ? null : { stalled: false })
    );
  }

  handleAudioTimeupdate() {
    const { currentTime, played } = this.audio;
    this.setState({ currentTime, played });
  }

  handleAudioLoadedmetadata() {
    if (this.audio.currentTime !== this.state.currentTime) {
      this.audio.currentTime = this.state.currentTime;
    }
    this.setState(
      state => (state.trackLoading === false ? null : { trackLoading: false })
    );
  }

  handleAudioVolumechange() {
    const { volume, muted } = this.audio;
    this.setState({ volume, muted });
  }

  handleAudioDurationchange() {
    const { duration } = this.audio;
    this.setState({ duration });
  }

  handleAudioProgress() {
    const { buffered } = this.audio;
    this.setState({ buffered });
  }

  handleAudioLoopchange() {
    const { loop } = this.audio;
    this.setState(state => (state.loop === loop ? null : { loop }));
  }

  handleAudioRatechange() {
    const { playbackRate } = this.audio;
    this.setState(
      state => (state.playbackRate === playbackRate ? null : { playbackRate })
    );
  }

  togglePause(value) {
    clearTimeout(this.delayTimeout);
    const pause = typeof value === 'boolean' ? value : !this.state.paused;
    if (pause) {
      this.audio.pause();
      return;
    }
    if (!this.audio.currentSrc) {
      return;
    }
    try {
      const playPromise = this.audio.play();
      if (playPromise && typeof playPromise.catch === 'function') {
        playPromise
          .catch(err => {
            // AbortError is pretty much always called because we're skipping
            // tracks quickly or hitting pause before a track has a chance to
            // play. It's pretty safe to just ignore these error messages.
            if (err.name !== 'AbortError') {
              return Promise.reject(err);
            }
          })
          .catch(playErrorHandler);
      }
    } catch (err) {
      playErrorHandler(err);
    }
  }

  // assumes playlist is valid - don't call without checking
  goToTrack(index, shouldPlay = true) {
    clearTimeout(this.delayTimeout);
    this.setState(state => getGoToTrackState(state, index, shouldPlay));
  }

  selectTrackIndex(index) {
    const { playlist } = this.props;
    if (!isPlaylistValid(playlist)) {
      return;
    }
    if (index < 0 || index > playlist.length) {
      logWarning(`Playlist index ${index} is out of bounds!`);
      return;
    }
    if (this.state.shuffle) {
      this.shuffler.pickNextItem(index, this.state.activeTrackIndex);
    }
    this.goToTrack(index);
  }

  backSkip() {
    const { playlist, stayOnBackSkipThreshold } = this.props;
    const { audio } = this;
    const { cycle, activeTrackIndex, shuffle } = this.state;
    if (
      !isPlaylistValid(playlist) ||
      audio.currentTime >= stayOnBackSkipThreshold ||
      (!cycle && activeTrackIndex < 1)
    ) {
      audio.currentTime = 0;
      return;
    }
    let index;
    if (shuffle) {
      const previousItem = this.shuffler.findPreviousItem(activeTrackIndex);
      if (previousItem === undefined) {
        // if we aren't allowing backShuffle then we'll hit a stopping point.
        audio.currentTime = 0;
        return;
      }
      index = findTrackIndexByUrl(playlist, previousItem);
    } else {
      index = activeTrackIndex - 1;
      if (index < 0) {
        index = playlist.length - 1;
      }
    }
    this.goToTrack(index);
  }

  forwardSkip() {
    const { playlist } = this.props;
    const { cycle, activeTrackIndex, shuffle } = this.state;
    if (
      !isPlaylistValid(playlist) ||
      (!cycle && activeTrackIndex + 1 >= playlist.length)
    ) {
      return;
    }
    let index;
    if (shuffle) {
      index = findTrackIndexByUrl(
        playlist,
        this.shuffler.findNextItem(activeTrackIndex)
      );
    } else {
      index = activeTrackIndex + 1;
      if (index >= playlist.length) {
        index = 0;
      }
    }
    this.goToTrack(index);
  }

  seekPreview(targetTime) {
    if (!isPlaylistValid(this.props.playlist)) {
      return;
    }
    const baseStateUpdate = {
      seekPreviewTime: targetTime,
      seekInProgress: true
    };
    switch (this.props.seekMode) {
      case 'paused':
        this.setState(({ paused, awaitingResumeOnSeekComplete }) => ({
          ...baseStateUpdate,
          awaitingResumeOnSeekComplete: paused
            ? awaitingResumeOnSeekComplete
            : true
        }));
        this.audio.currentTime = targetTime;
        if (!this.state.paused) {
          this.togglePause(true);
        }
        break;
      case 'immediate':
        this.setState(baseStateUpdate);
        this.audio.currentTime = targetTime;
        break;
      case 'onrelease':
        this.setState(baseStateUpdate);
        break;
    }
  }

  seekComplete() {
    const { seekPreviewTime, awaitingResumeOnSeekComplete } = this.state;
    const baseStateUpdate = {
      seekInProgress: false,
      awaitingResumeOnSeekComplete: false
    };
    if (isNaN(seekPreviewTime)) {
      this.setState(baseStateUpdate);
      return;
    }
    this.setState({
      ...baseStateUpdate,
      /* we'll update currentTime on the audio listener hook anyway,
       * but that might not happen for a bit... so the optimistic update
       * helps us avoid the progress bar jumping around and confusing the user.
       * https://github.com/benwiley4000/react-responsive-audio-player/issues/209
       */
      currentTime: seekPreviewTime
    });
    this.audio.currentTime = seekPreviewTime;
    if (awaitingResumeOnSeekComplete) {
      this.togglePause(false);
    }
  }

  setVolume(volume) {
    if (!this.state.setVolumeInProgress) {
      this.setState({
        setVolumeInProgress: true
      });
    }
    const volumeInBounds = convertToNumberWithinIntervalBounds(volume, 0, 1);
    this.audio.muted = volumeInBounds === 0 ? true : false;
    this.audio.volume = volumeInBounds;
  }

  setVolumeComplete() {
    this.setState({
      setVolumeInProgress: false
    });
    if (!this.audio.muted) {
      this.lastStableVolume = this.audio.volume;
    }
  }

  toggleMuted(value) {
    const muted = typeof value === 'boolean' ? value : !this.state.muted;
    this.audio.muted = muted;
    if (!muted) {
      this.audio.volume = this.lastStableVolume;
    }
  }

  toggleShuffle(value) {
    const shuffle = typeof value === 'boolean' ? value : !this.state.shuffle;
    this.setState({ shuffle });
  }

  setRepeatStrategy(repeatStrategy) {
    if (repeatStrategyOptions.indexOf(repeatStrategy) === -1) {
      logWarning(
        'repeatStrategy "' +
          repeatStrategy +
          '" is not one of: ' +
          repeatStrategyOptions.split(', ') +
          '.'
      );
      return;
    }
    this.setState(() => {
      switch (repeatStrategy) {
        case 'track':
          return {
            loop: true
          };
        case 'playlist':
          return {
            loop: false,
            cycle: true
          };
        case 'none':
          return {
            loop: false,
            cycle: false
          };
        default:
          return null;
      }
    });
  }

  setPlaybackRate(rate) {
    this.audio.playbackRate = rate;
  }

  getControlProps() {
    const { props, state } = this;
    return {
      playlist: props.playlist,
      activeTrackIndex: state.activeTrackIndex,
      trackLoading: state.trackLoading,
      paused: state.paused,
      currentTime: state.currentTime,
      seekPreviewTime: state.seekPreviewTime,
      seekInProgress: state.seekInProgress,
      awaitingResumeOnSeekComplete: state.awaitingResumeOnSeekComplete,
      duration: state.duration,
      buffered: state.buffered,
      played: state.played,
      volume: state.volume,
      muted: state.muted,
      shuffle: state.shuffle,
      stalled: state.stalled,
      playbackRate: state.playbackRate,
      setVolumeInProgress: state.setVolumeInProgress,
      repeatStrategy: getRepeatStrategy(state.loop, state.cycle),
      pipeVideoStreamToCanvas: this.pipeVideoStreamToCanvas,
      onTogglePause: this.togglePause,
      onSelectTrackIndex: this.selectTrackIndex,
      onBackSkip: this.backSkip,
      onForwardSkip: this.forwardSkip,
      onSeekPreview: this.seekPreview,
      onSeekComplete: this.seekComplete,
      onSetVolume: this.setVolume,
      onSetVolumeComplete: this.setVolumeComplete,
      onToggleMuted: this.toggleMuted,
      onToggleShuffle: this.toggleShuffle,
      onSetRepeatStrategy: this.setRepeatStrategy,
      onSetPlaybackRate: this.setPlaybackRate
    };
  }

  render() {
    const sources = getTrackSources(
      this.props.playlist,
      this.state.activeTrackIndex
    );
    const playerContext = this.getControlProps();
    return (
      <Fragment>
        <video
          hidden
          ref={this.setAudioElementRef}
          crossOrigin={this.props.crossOrigin}
          preload="metadata"
          loop={this.state.loop}
          onPlay={this.handleAudioPlay}
          onPause={this.handleAudioPause}
          onEnded={this.handleAudioEnded}
          onStalled={this.handleAudioStalled}
          onCanPlayThrough={this.handleAudioCanplaythrough}
          onTimeUpdate={this.handleAudioTimeupdate}
          onLoadedMetadata={this.handleAudioLoadedmetadata}
          onVolumeChange={this.handleAudioVolumechange}
          onDurationChange={this.handleAudioDurationchange}
          onProgress={this.handleAudioProgress}
          onRateChange={this.handleAudioRatechange}
        >
          {sources.map(source => (
            <source key={source.src} src={source.src} type={source.type} />
          ))}
        </video>
        <PlayerContext.Provider value={playerContext}>
          {typeof this.props.children === 'function'
            ? this.props.children(playerContext)
            : this.props.children}
        </PlayerContext.Provider>
      </Fragment>
    );
  }
}

PlayerContextProvider.propTypes = {
  playlist: PropTypes.arrayOf(PlayerPropTypes.track.isRequired).isRequired,
  autoplay: PropTypes.bool.isRequired,
  autoplayDelayInSeconds: PropTypes.number.isRequired,
  gapLengthInSeconds: PropTypes.number.isRequired,
  crossOrigin: PlayerPropTypes.crossOriginAttribute,
  defaultVolume: PropTypes.number.isRequired,
  defaultMuted: PropTypes.bool,
  defaultRepeatStrategy: PlayerPropTypes.repeatStrategy.isRequired,
  defaultShuffle: PropTypes.bool,
  defaultPlaybackRate: PropTypes.number.isRequired,
  startingTime: PropTypes.number.isRequired,
  startingTrackIndex: PropTypes.number.isRequired,
  loadFirstTrackOnPlaylistComplete: PropTypes.bool,
  seekMode: PlayerPropTypes.seekMode.isRequired,
  allowBackShuffle: PropTypes.bool,
  stayOnBackSkipThreshold: PropTypes.number.isRequired,
  supportedMediaSessionActions: PropTypes.arrayOf(
    PlayerPropTypes.mediaSessionAction.isRequired
  ).isRequired,
  mediaSessionSeekLengthInSeconds: PropTypes.number.isRequired,
  audioElementRef: PropTypes.func,
  initialStateSnapshot: PropTypes.shape({
    __unstable__: PropTypes.object.isRequired
  }),
  onStateSnapshot: PropTypes.func,
  children: PropTypes.oneOfType([PropTypes.node, PropTypes.func]).isRequired
};

PlayerContextProvider.defaultProps = {
  autoplay: false,
  autoplayDelayInSeconds: 0,
  gapLengthInSeconds: 0,
  defaultVolume: 1,
  defaultMuted: false,
  defaultRepeatStrategy: 'playlist',
  defaultShuffle: false,
  defaultPlaybackRate: 1,
  startingTime: 0,
  startingTrackIndex: 0,
  loadFirstTrackOnPlaylistComplete: true,
  seekMode: 'immediate',
  maintainPlaybackRate: false,
  allowBackShuffle: false,
  stayOnBackSkipThreshold: 5,
  supportedMediaSessionActions: ['play', 'pause', 'previoustrack', 'nexttrack'],
  mediaSessionSeekLengthInSeconds: 10
};

class PlayerContextGroupMember extends Component {
  componentDidMount() {
    this.props.groupContext.registerMediaElement(this.mediaElement);
  }

  componentWillUnmount() {
    this.props.groupContext.unregisterMediaElement(this.mediaElement);
  }

  render() {
    const { groupContext, props } = this.props;
    const { audioElementRef, ...rest } = props;
    return (
      <PlayerContextProvider
        {...groupContext.groupProps}
        {...rest}
        audioElementRef={ref => {
          if (audioElementRef) {
            audioElementRef(ref);
          }
          this.mediaElement = ref;
        }}
      />
    );
  }
}

PlayerContextGroupMember.propTypes = {
  groupContext: PropTypes.shape({
    groupProps: PropTypes.object.isRequired,
    registerMediaElement: PropTypes.func.isRequired,
    unregisterMediaElement: PropTypes.func.isRequired
  }).isRequired
};

function PlayerContextGroupConsumer(props) {
  return (
    <GroupContext.Consumer>
      {groupContext => {
        if (!groupContext) {
          return createElement(PlayerContextProvider, props);
        }
        return createElement(PlayerContextGroupMember, {
          groupContext,
          props
        });
      }}
    </GroupContext.Consumer>
  );
}

export default PlayerContextGroupConsumer;