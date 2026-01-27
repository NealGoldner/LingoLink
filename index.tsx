
import React, { useState, useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { GoogleGenAI, LiveServerMessage, Modality, Blob, Type } from '@google/genai';

// --- 类型定义 ---
interface Diagnosis {
  correction: string;
  nativeWay: string;
  explanation: string;
}

interface Message {
  id: string;
  role: 'user' | 'ai';
  text: string;
  translation?: string;
  diagnosis?: Diagnosis;
  isTranslating?: boolean;
  isDiagnosing?: boolean;
}

declare global {
  interface AIStudio {
    hasSelectedApiKey: () => Promise<boolean>;
    openSelectKey: () => Promise<void>;
  }
  var aistudio: AIStudio;
}

// --- 常量配置 ---
const LIVE_MODEL_NAME = 'gemini-2.5-flash-native-audio-preview-12-2025';
const ANALYSIS_MODEL_NAME = 'gemini-3-flash-preview'; 
const TTS_MODEL_NAME = 'gemini-2.5-flash-preview-tts';

// --- 辅助函数 ---
function encode(bytes: Uint8Array) {
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function decode(base64: string) {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

async function decodeAudioData(
  data: Uint8Array,
  ctx: AudioContext,
  sampleRate: number,
  numChannels: number,
): Promise<AudioBuffer> {
  const dataInt16 = new Int16Array(data.buffer);
  const frameCount = dataInt16.length / numChannels;
  const buffer = ctx.createBuffer(numChannels, frameCount, sampleRate);

  for (let channel = 0; channel < numChannels; channel++) {
    const channelData = buffer.getChannelData(channel);
    for (let i = 0; i < frameCount; i++) {
      channelData[i] = dataInt16[i * numChannels + channel] / 32768.0;
    }
  }
  return buffer;
}

const App: React.FC = () => {
  const [messages, setMessages] = useState<Message[]>([
    {
      id: '1',
      role: 'ai',
      text: "Yooo! It's Vibe in the house! 🎤 Ready to drop some knowledge or just debate why cereal is technically a soup? What's the move today, my friend?"
    }
  ]);
  const [isSessionActive, setIsSessionActive] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [globalBilingual, setGlobalBilingual] = useState(false);
  const [globalDiagnosis, setGlobalDiagnosis] = useState(true);
  const [isAISpeaking, setIsAISpeaking] = useState(false);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [statusText, setStatusText] = useState('准备就绪');
  const [errorText, setErrorText] = useState<React.ReactNode | null>(null);
  
  const scrollRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<any>(null);
  const inputAudioCtxRef = useRef<AudioContext | null>(null);
  const outputAudioCtxRef = useRef<AudioContext | null>(null);
  const nextStartTimeRef = useRef(0);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  
  const currentInputText = useRef('');
  const currentOutputText = useRef('');
  
  const globalBilingualRef = useRef(globalBilingual);
  const globalDiagnosisRef = useRef(globalDiagnosis);

  useEffect(() => {
    globalBilingualRef.current = globalBilingual;
    if (globalBilingual) {
      messages.forEach(msg => {
        if (msg.role === 'ai' && !msg.translation && !msg.isTranslating) {
          handleTranslate(msg.id, msg.text);
        }
      });
    }
  }, [globalBilingual]);

  useEffect(() => {
    globalDiagnosisRef.current = globalDiagnosis;
  }, [globalDiagnosis]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
    }
  }, [messages]);

  useEffect(() => {
    const checkStatus = setInterval(() => {
      const active = sourcesRef.current.size > 0;
      if (active !== isAISpeaking) setIsAISpeaking(active);
    }, 100);
    return () => clearInterval(checkStatus);
  }, [isAISpeaking]);

  const handleTranslate = async (id: string, text: string) => {
    const aiKey = process.env.API_KEY;
    if (!aiKey) return;
    setMessages(prev => prev.map(m => m.id === id ? { ...m, isTranslating: true } : m));
    try {
      const ai = new GoogleGenAI({ apiKey: aiKey });
      const response = await ai.models.generateContent({
        model: ANALYSIS_MODEL_NAME,
        contents: `Translate this to cool Chinese: "${text}"`,
        config: { systemInstruction: "Output ONLY translation.", temperature: 0.1 }
      });
      setMessages(prev => prev.map(m => m.id === id ? { ...m, translation: response.text?.trim(), isTranslating: false } : m));
    } catch {
      setMessages(prev => prev.map(m => m.id === id ? { ...m, isTranslating: false } : m));
    }
  };

  const handleDiagnose = async (id: string, text: string) => {
    const aiKey = process.env.API_KEY;
    if (!aiKey) return;
    setMessages(prev => prev.map(m => m.id === id ? { ...m, isDiagnosing: true } : m));
    try {
      const ai = new GoogleGenAI({ apiKey: aiKey });
      const response = await ai.models.generateContent({
        model: ANALYSIS_MODEL_NAME,
        contents: `The following text is transcribed from user voice. 
        IGNORE non-meaningful formatting errors (caps, periods). 
        FOCUS ON: Grammar, naturalness, and cool flow.
        USER_TEXT: "${text}"`,
        config: { 
          systemInstruction: `You are 'Vibe', the world's most charismatic English coach. 
          When diagnosing the user's speech:
          1. Keep it high-energy, witty, and super encouraging. 
          2. Use a mix of cool English and pithy Chinese. 
          3. 'correction': Make it a solid, grammatically correct version. 
          4. 'nativeWay': Give them the 'street cred' version—how a native speaker actually talks (idioms, contractions, natural flow).
          5. 'explanation': Keep it snappy, fun, and insightful in Chinese. Avoid 'teacher' talk. Use 'Vibe' persona.`,
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              correction: { type: Type.STRING },
              nativeWay: { type: Type.STRING },
              explanation: { type: Type.STRING }
            },
            required: ["correction", "nativeWay", "explanation"]
          }
        }
      });
      const diagnosis = JSON.parse(response.text || '{}');
      setMessages(prev => prev.map(m => m.id === id ? { ...m, diagnosis, isDiagnosing: false } : m));
    } catch (err) {
      setMessages(prev => prev.map(m => m.id === id ? { ...m, isDiagnosing: false } : m));
    }
  };

  const playTTS = async (text: string, playId: string) => {
    const aiKey = process.env.API_KEY;
    if (!aiKey || playingId) return;
    setPlayingId(playId);
    try {
      const ai = new GoogleGenAI({ apiKey: aiKey });
      const response = await ai.models.generateContent({
        model: TTS_MODEL_NAME,
        contents: [{ parts: [{ text: `Say this with great vibes: ${text}` }] }],
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Puck' } } },
        },
      });
      const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
      if (base64Audio && outputAudioCtxRef.current) {
        const ctx = outputAudioCtxRef.current;
        const audioBuffer = await decodeAudioData(decode(base64Audio), ctx, 24000, 1);
        const source = ctx.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(ctx.destination);
        source.onended = () => setPlayingId(null);
        source.start();
      } else {
        setPlayingId(null);
      }
    } catch (err) {
      setPlayingId(null);
    }
  };

  const startSession = async () => {
    if (isSessionActive || isConnecting) return;
    if (!inputAudioCtxRef.current) inputAudioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
    if (!outputAudioCtxRef.current) outputAudioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
    await inputAudioCtxRef.current.resume();
    await outputAudioCtxRef.current.resume();
    setIsConnecting(true);
    setStatusText('正在召唤 Vibe...');

    try {
      const currentApiKey = process.env.API_KEY;
      if (!currentApiKey) throw new Error("请设置 API 密钥以继续");
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const ai = new GoogleGenAI({ apiKey: currentApiKey });
      const sessionPromise = ai.live.connect({
        model: LIVE_MODEL_NAME,
        callbacks: {
          onopen: () => {
            setIsSessionActive(true);
            setIsConnecting(false);
            setStatusText('正在热聊中');
            const source = inputAudioCtxRef.current!.createMediaStreamSource(stream);
            const scriptProcessor = inputAudioCtxRef.current!.createScriptProcessor(4096, 1, 1);
            scriptProcessor.onaudioprocess = (e) => {
              const inputData = e.inputBuffer.getChannelData(0);
              const int16 = new Int16Array(inputData.length);
              for (let i = 0; i < inputData.length; i++) int16[i] = inputData[i] * 32768;
              const pcmBlob: Blob = { data: encode(new Uint8Array(int16.buffer)), mimeType: 'audio/pcm;rate=16000' };
              sessionPromise.then(session => {
                if (sourcesRef.current.size === 0) session.sendRealtimeInput({ media: pcmBlob });
              });
            };
            source.connect(scriptProcessor);
            scriptProcessor.connect(inputAudioCtxRef.current!.destination);
            sessionRef.current = { stop: () => { stream.getTracks().forEach(t => t.stop()); scriptProcessor.disconnect(); source.disconnect(); } };
          },
          onmessage: async (message: LiveServerMessage) => {
            const base64Audio = message.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
            if (base64Audio) {
              const ctx = outputAudioCtxRef.current!;
              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, ctx.currentTime);
              const audioBuffer = await decodeAudioData(decode(base64Audio), ctx, 24000, 1);
              const source = ctx.createBufferSource();
              source.buffer = audioBuffer;
              source.connect(ctx.destination);
              sourcesRef.current.add(source);
              source.onended = () => sourcesRef.current.delete(source);
              source.start(nextStartTimeRef.current);
              nextStartTimeRef.current += audioBuffer.duration;
            }
            if (message.serverContent?.inputTranscription) currentInputText.current += message.serverContent.inputTranscription.text || '';
            if (message.serverContent?.outputTranscription) currentOutputText.current += message.serverContent.outputTranscription.text || '';
            if (message.serverContent?.turnComplete) {
              const uText = currentInputText.current.trim();
              const aText = currentOutputText.current.trim();
              if (uText) {
                const id = `u-${Date.now()}`;
                setMessages(prev => [...prev, { id, role: 'user', text: uText }]);
                if (globalDiagnosisRef.current) handleDiagnose(id, uText);
              }
              if (aText) {
                const id = `a-${Date.now()}`;
                setMessages(prev => [...prev, { id, role: 'ai', text: aText }]);
                if (globalBilingualRef.current) handleTranslate(id, aText);
              }
              currentInputText.current = ''; currentOutputText.current = '';
            }
          },
          onerror: (err: any) => { stopSession(); },
          onclose: () => stopSession()
        },
        config: {
          responseModalities: [Modality.AUDIO],
          systemInstruction: `You are 'Vibe', a high-energy English coach. Chat like a best friend. Keep the energy high and the talk interesting.`,
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Zephyr' } } },
          inputAudioTranscription: {},
          outputAudioTranscription: {}
        }
      });
    } catch (err: any) {
      setIsConnecting(false);
      setErrorText(err.message || '麦克风错误');
    }
  };

  const stopSession = () => {
    if (sessionRef.current) sessionRef.current.stop();
    setIsSessionActive(false);
    setIsConnecting(false);
    setStatusText('通话结束');
  };

  return (
    <div className="flex flex-col h-screen max-w-[1200px] mx-auto relative overflow-hidden font-sans border-x border-[#E1E8E1] shadow-2xl">
      <header className="glass-header px-4 sm:px-12 py-5 flex flex-col gap-4 sticky top-0 z-50">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4 sm:gap-6">
            <div className={`relative w-12 h-12 rounded-2xl flex items-center justify-center text-white shadow-lg transition-all duration-500 ${isSessionActive ? 'bg-[#2D5A27] scale-110 rotate-12' : 'bg-stone-300'}`}>
              <i className="fas fa-bolt text-xl"></i>
            </div>
            <div className="flex flex-col">
              <h1 className="font-heading font-bold text-xl sm:text-2xl text-[#1A2E1A] tracking-tight">LingoLink</h1>
              <p className="text-[10px] text-[#5E7A5E] uppercase tracking-widest font-bold leading-none mt-1">{statusText}</p>
            </div>
          </div>
          
          <div className="flex items-center gap-3">
            <div className="flex items-center bg-white/50 backdrop-blur-sm p-1 rounded-xl border border-stone-200 gap-1">
               <button onClick={() => setGlobalBilingual(!globalBilingual)} className={`px-3 py-1.5 rounded-lg text-[9px] font-black uppercase transition-all ${globalBilingual ? 'bg-[#2D5A27] text-white shadow-sm' : 'text-[#5E7A5E] hover:bg-stone-100'}`}>双语</button>
               <button onClick={() => setGlobalDiagnosis(!globalDiagnosis)} className={`px-3 py-1.5 rounded-lg text-[9px] font-black uppercase transition-all ${globalDiagnosis ? 'bg-stone-800 text-white shadow-sm' : 'text-[#5E7A5E] hover:bg-stone-100'}`}>大师诊断</button>
            </div>
            <button onClick={() => window.aistudio?.openSelectKey()} className="w-10 h-10 rounded-xl bg-white border border-stone-200 flex items-center justify-center hover:shadow-md transition-all"><i className="fas fa-key text-[#2D5A27]"></i></button>
          </div>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden relative">
        <main ref={scrollRef} className="flex-1 overflow-y-auto px-4 sm:px-16 py-10 space-y-10 chat-area-mask no-scrollbar pb-44">
          {messages.map((msg) => (
            <div key={msg.id} className={`flex flex-col ${msg.role === 'user' ? 'items-end' : 'items-start'}`}>
              <div className={`message-bubble p-5 sm:p-8 rounded-[2rem] ${msg.role === 'user' ? 'user-bubble' : 'ai-bubble'} relative`}>
                <p className="text-[15px] sm:text-[17px] font-medium leading-relaxed whitespace-pre-wrap">{msg.text}</p>
                
                {msg.role === 'user' && (msg.diagnosis || msg.isDiagnosing) && (
                   <div className="mt-5 pt-5 border-t border-white/20 overflow-hidden">
                     {msg.isDiagnosing ? (
                       <div className="flex items-center gap-3 animate-pulse opacity-70">
                         <i className="fas fa-satellite-dish text-lg"></i>
                         <span className="text-[10px] font-black uppercase tracking-widest">正在捕捉你的语言波动...</span>
                       </div>
                     ) : (
                       <div className="space-y-4">
                         <div className="flex items-start gap-4 group bg-black/10 p-4 rounded-2xl border border-white/5 transition-colors hover:bg-black/20">
                           <div className="w-8 h-8 rounded-lg bg-emerald-500/20 flex items-center justify-center shrink-0">
                             <i className="fas fa-sparkles text-emerald-400 text-xs"></i>
                           </div>
                           <div className="flex-1">
                             <p className="text-[9px] uppercase font-black tracking-tighter text-white/40 mb-1">Vibe Check (Corrected)</p>
                             <div className="flex items-center justify-between gap-2">
                               <p className="text-sm font-bold text-emerald-100 leading-tight">{msg.diagnosis?.correction}</p>
                               <button 
                                 onClick={() => playTTS(msg.diagnosis!.correction, `${msg.id}-fix`)}
                                 className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 transition-all ${playingId === `${msg.id}-fix` ? 'bg-emerald-400 text-emerald-900 animate-pulse' : 'bg-white/10 text-white/60 hover:bg-white/20'}`}
                               >
                                 <i className={`fas ${playingId === `${msg.id}-fix` ? 'fa-spinner fa-spin' : 'fa-play'} text-[10px]`}></i>
                               </button>
                             </div>
                           </div>
                         </div>
                         
                         <div className="flex items-start gap-4 group bg-black/10 p-4 rounded-2xl border border-white/5 transition-colors hover:bg-black/20">
                           <div className="w-8 h-8 rounded-lg bg-amber-500/20 flex items-center justify-center shrink-0">
                             <i className="fas fa-fire text-amber-400 text-xs"></i>
                           </div>
                           <div className="flex-1">
                             <p className="text-[9px] uppercase font-black tracking-tighter text-white/40 mb-1">Native Flow (Street Cred)</p>
                             <div className="flex items-center justify-between gap-2">
                               <p className="text-sm font-bold text-amber-100 leading-tight">{msg.diagnosis?.nativeWay}</p>
                               <button 
                                 onClick={() => playTTS(msg.diagnosis!.nativeWay, `${msg.id}-native`)}
                                 className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 transition-all ${playingId === `${msg.id}-native` ? 'bg-amber-400 text-amber-900 animate-pulse' : 'bg-white/10 text-white/60 hover:bg-white/20'}`}
                               >
                                 <i className={`fas ${playingId === `${msg.id}-native` ? 'fa-spinner fa-spin' : 'fa-play'} text-[10px]`}></i>
                               </button>
                             </div>
                           </div>
                         </div>
                         <div className="relative pl-12">
                           <div className="absolute left-6 top-0 bottom-0 w-px bg-white/10"></div>
                           <p className="text-[11px] font-medium text-white/60 italic leading-snug">{msg.diagnosis?.explanation}</p>
                         </div>
                       </div>
                     )}
                   </div>
                )}
                {msg.role === 'ai' && (msg.translation || msg.isTranslating) && (
                   <div className="mt-4 pt-4 border-t border-stone-100/50 text-sm text-[#5E7A5E] italic">
                     {msg.isTranslating ? <div className="loader !w-4 !h-4 !border-2"></div> : msg.translation}
                   </div>
                )}
              </div>
            </div>
          ))}
          {isAISpeaking && (
            <div className="ml-8 flex items-center gap-4 p-4 bg-white/60 backdrop-blur rounded-full border border-stone-200/50 w-fit animate-fadeIn">
              <div className="voice-wave">
                {[0, 0.1, 0.2, 0.3, 0.4].map(d => <span key={d} style={{ animationDelay: `${d}s` }}></span>)}
              </div>
              <span className="text-[9px] font-black uppercase text-[#2D5A27]">Vibe Dropping...</span>
            </div>
          )}
        </main>
      </div>

      <footer className="absolute bottom-10 left-0 right-0 flex flex-col items-center pointer-events-none z-50">
        <button onClick={isSessionActive ? stopSession : startSession} disabled={isConnecting || !isOnline} className={`pointer-events-auto w-24 h-24 sm:w-28 sm:h-28 rounded-full flex items-center justify-center text-3xl sm:text-4xl shadow-2xl transition-all duration-500 relative z-10 ${isSessionActive ? 'bg-[#2D5A27] text-white ring-8 ring-[#2D5A27]/10' : 'bg-white text-[#2D5A27] border-2 border-stone-100'}`}>
          {isConnecting ? <div className="loader !w-10 !h-10 !border-[4px]"></div> : <i className={`fas ${isSessionActive ? 'fa-microphone' : 'fa-microphone-slash opacity-40'}`}></i>}
        </button>
      </footer>
    </div>
  );
};

const root = createRoot(document.getElementById('root')!);
root.render(<App />);
