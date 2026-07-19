Reading additional input from stdin...
OpenAI Codex v0.144.4
--------
workdir: /home/iszzu/marveen
model: gpt-5.6-sol
provider: openai
approval: never
sandbox: workspace-write [workdir, /tmp, $TMPDIR]
reasoning effort: high
reasoning summaries: none
session id: 019f76a8-8260-7b92-94a6-63c15d116873
--------
user
Te egy fuggetlen adojogi ellenorzo vagy. NEM elemezni kell, hanem CAFOLNI probalni.

Egy magyar mikrovallalkozoi konyvelo-szoftver (MikroKonyv) 2026-os ATALANYADOZASI szabalykeszletet epitettunk be. Egy kollega mar kiolvasta ezeket elsodleges forrasbol. A te feladatod NEM megismetelni az o munkajat, hanem FUGGETLENUL megallapitani, hogy az alabbi ertekek helyesek-e a 2026-os magyar szabalyozas szerint, es megjelolni BARMELYIKET, ami tevesnek vagy elavultnak tunik.

AZ ELLENORIZENDO ERTEKEK (egyeni vallalkozo, atalanyadozas, 2026):
1. TB-jarulek merteke: 18,5%
2. Szocialis hozzajarulasi ado merteke: 13%
3. Koltseghanyad kulcsok: 45% (altalanos), 80%, 90%
4. Adomentes ertekhatar: 1 936 800 Ft
5. Atalanyadozas bevetel-ertekhatara: 38 736 000 Ft
6. Kiskereskedelmi tevekenysegre vonatkozo ertekhatar: 193 680 000 Ft
7. Minimalber: 322 800 Ft/ho ; garantalt bermininum: 373 200 Ft/ho
8. Negyedeves adoelolegfizetesi hatarido: a negyedevet koveto honap 12. napja
9. A 112,5%-os szocho-szorzo 2026-ra MEGSZUNT (nem alkalmazando)
10. Naparanyos minimum-alap szamitas toredek-honapra: minimalber / 30 * napok szama

MINDEN ERTEKNEL add meg:
- HELYES / TEVES / BIZONYTALAN
- ha TEVES: mi a helyes ertek
- a forras megnevezese (jogszabaly szakasz vagy NAV-kiadvany), es hogy 2026-ra hatalyos-e
- ha BIZONYTALAN: pontosan mi az, amit nem tudsz megerositeni

KULON KERDES a 10. ponthoz: a toredek-honapos (evkozi indulas, szuneteles) minimum-alap aranyositasa TENYLEGESEN nap-alapu-e a magyar szabalyozasban, vagy egesz honapos? Ez a legfontosabb kerdesem, mert a motorunk jelenleg egesz honapokkal szamol.

FONTOS: ha egy ertekrol nem talalsz megbizhato 2026-os forrast, azt BIZONYTALAN-nak jelold. NE talalj ki szamot es NE vezess le 2025-os adatbol 2026-osat. A "nem tudom megerositeni" hasznos valasz; egy magabiztos rossz szam valodi vallalkozo valodi adojat rontja el.
codex
Független, cáfoló ellenőrzést végzek: minden pontot 2026-ban hatályos jogszabályhoz vagy NAV-anyaghoz kötök, és külön utánanézek, hogy a minimumalap tört hónapnál valóban napi arányosítású-e. Mivel ez nagy pontosságú adójogi kérdés, elsődleges/hatósági online forrásokat ellenőrzök.
web search: 
web search: site:nav.gov.hu 2026 átalányadózás 45 százalék 1 936 800 38 736 000 ...
web search: 
web search: site:nav.gov.hu/pfile/file 2026 "112,5" szocho átalányadózó egyéni vállalkozó ...
codex
Az első cáfoló eredmény már látszik: a 10. pont általános képletként túl tág. A törvény napi „harmincadolást” valóban ismer, de nem minden tört hónapra azonosan; különösen a hónap közbeni szünetelésnél van olyan eset, amikor a teljes havi minimumalap marad. Most az indulás–megszűnés–szünetelés eseteket külön választom.
web search: 
web search: 
web search: 
web search: site:nav.gov.hu/pfile/file 2026 átalányadózó "adóelőleget" "12-éig" ...
web search: 
web search: 
web search: 
web search: 'harmincad részét'
web search: 
web search: 
web search: 
web search: '2026. január 1-jén'
web search: 
web search: site:njt.hu/jogszabaly/2019-122 "garantált bérminimum havi összege" egyéni vállalkozó ...
web search: 
web search: site:njt.hu/jogszabaly/1995-117-00-00 "53. §" "45 százalék" ...
codex
A motor szempontjából a döntő különbség megerősítést nyert: hónap közbeni indulás/megszűnés esetén napi alap számít, de a 2024-től megkezdett, csak hónaprészre eső szünetelés nem csökkenti naparányosan a minimumot. Ezért a jelenlegi „csak egész hónapok” logika az indulást/megszűnést túladóztatná, az általános `/30 × napok` logika viszont a rész-havi szünetelést aluladóztatná.
web search: 
web search: site:nav.gov.hu 2026 "2023-ban megkezdte" "szocho" szünetelés harmincadolás ...
web search: 
web search: 'Ha a szünetelés nem áll fenn'
web search: 
web search: 
web search: 
web search: site:nav.gov.hu 2026 április 12 átalányadózó határidő április 13 ...
codex
Az ellenőrzött tíz állítás közül az 1–9. pont számszerűen helyes. A 10. pont általános szabályként TÉVES: a minimumalap napi arányosítása csak meghatározott esetekben alkalmazható, a rész-havi szünetelésre főszabály szerint nem.

Az ellenőrzés időpontja: 2026. július 18. Nemzeti Jogszabálytárban szereplő, 2026-ra hatályos szöveget és 2026-os NAV-kiadványokat használtam.

### Tételes ellenőrzés

1. **TB-járulék: 18,5% — HELYES**

A társadalombiztosítási járulék mértéke 18,5%.

Forrás: Tbj., azaz a 2019. évi CXXII. törvény 25. § (1). [Nemzeti Jogszabálytár – Tbj.](https://njt.hu/jogszabaly/2019-122-00-00.28)  
2026-ra hatályos: igen.

2. **Szocho: 13% — HELYES**

A szociális hozzájárulási adó általános mértéke az adóalap 13%-a.

Forrás: Szocho tv., azaz a 2018. évi LII. törvény 2. § (1). [Nemzeti Jogszabálytár – Szocho tv.](https://njt.hu/jogszabaly/2018-52-00-00)  
2026-ra hatályos: igen.

3. **Költséghányadok: 45%, 80%, 90% — HELYES**

A három 2026-os kulcs valóban:

- 45%: általános költséghányad;
- 80%: az Szja tv. 53. § (2)-ben felsorolt tevékenységekre;
- 90%: kizárólagos kiskereskedelmi tevékenységre, a törvényben megengedett postai tevékenységekkel.

Forrás: Szja tv. 53. §; a 45%-ot a 2025. évi LXXXIV. törvény 3. § a) pontja vezette be 2026. január 1-jével. [NAV 100. információs füzet, 2026](https://nav.gov.hu/pfile/file?path=%2Fugyfeliranytu%2Fnezzen-utana%2Finf_fuz%2F2026%2F100.-Az-egyeni-vallalkozok-atalanyadozasanak-alapveto-szabalyai-2026.-01.-19), [módosító törvény és hatálybalépés](https://njt.hu/jogszabaly/2025-84-00-00.5)  
2026-ra hatályos: igen.

Motoros figyelmeztetés: a 90% nem általában „kiskereskedelmi bevételre” alkalmazható, hanem a kizárólagossági feltétel teljesülésekor. Az év közbeni tevékenységváltás is visszahathat az alkalmazható költséghányadra.

4. **Adómentes értékhatár: 1 936 800 Ft — HELYES**

Ez az éves minimálbér fele:

`322 800 × 12 / 2 = 1 936 800 Ft`.

Fontos: ez jövedelmi, nem bevételi határ. Az átalányban megállapított jövedelem eddig a pontig adómentes. Év közbeni áttérésnél sem kell arányosítani.

Forrás: Szja tv. 1. számú melléklet 4.48.; [NAV 100. információs füzet, 2026](https://nav.gov.hu/pfile/file?path=%2Fugyfeliranytu%2Fnezzen-utana%2Finf_fuz%2F2026%2F100.-Az-egyeni-vallalkozok-atalanyadozasanak-alapveto-szabalyai-2026.-01.-19)  
2026-ra hatályos: igen.

5. **Átalányadózási bevételi értékhatár: 38 736 000 Ft — HELYES, teljes évre**

Az éves minimálbér tízszerese:

`322 800 × 12 × 10 = 38 736 000 Ft`.

Forrás: Szja tv. 50. § (1), 52. § (1); [NAV 100. információs füzet, 2026](https://nav.gov.hu/pfile/file?path=%2Fugyfeliranytu%2Fnezzen-utana%2Finf_fuz%2F2026%2F100.-Az-egyeni-vallalkozok-atalanyadozasanak-alapveto-szabalyai-2026.-01.-19)  
2026-ra hatályos: igen.

Fontos: év közbeni kezdés, megszüntetés vagy szünetelés esetén ezt a bevételi értékhatárt a tevékenység folytatásának napjaival időarányosítani kell.

6. **Kiskereskedelmi értékhatár: 193 680 000 Ft — HELYES, teljes évre**

Az éves minimálbér ötvenszerese:

`322 800 × 12 × 50 = 193 680 000 Ft`.

Forrás: Szja tv. 50. § (4), 52. § (1) b); [NAV 100. információs füzet, 2026](https://nav.gov.hu/pfile/file?path=%2Fugyfeliranytu%2Fnezzen-utana%2Finf_fuz%2F2026%2F100.-Az-egyeni-vallalkozok-atalanyadozasanak-alapveto-szabalyai-2026.-01.-19)  
2026-ra hatályos: igen.

Korlát: kizárólag kiskereskedelmi tevékenységet végző vállalkozóra vonatkozik, a törvényben külön megengedett postai közreműködői és egyéb tevékenységek kivételével. Év közbeni kezdés, megszüntetés vagy szünetelés esetén ez is időarányos.

7. **Minimálbér 322 800 Ft; garantált bérminimum 373 200 Ft — HELYES**

Forrás: 426/2025. (XII. 23.) Korm. rendelet 2. § (1)–(2). [Nemzeti Jogszabálytár – 426/2025. Korm. rendelet](https://njt.hu/jogszabaly/2025-426-20-22)  
2026-ra hatályos: igen, 2026. január 1-jétől.

A járulék- és szocho-minimumalapnál a garantált bérminimumot kell használni, ha a személyesen végzett főtevékenység legalább középfokú végzettséget vagy szakképzettséget igényel.

8. **Negyedéves adóelőleg határideje: következő hónap 12. napja — HELYES**

Az egyéni vállalkozói tevékenységhez kapcsolódó személyijövedelemadó-előleget negyedévente, a negyedévet követő hónap 12-éig kell megfizetni.

Forrás: Szja tv. 46. § (9); [NAV 100. információs füzet, 2026](https://nav.gov.hu/pfile/file?path=%2Fugyfeliranytu%2Fnezzen-utana%2Finf_fuz%2F2026%2F100.-Az-egyeni-vallalkozok-atalanyadozasanak-alapveto-szabalyai-2026.-01.-19)  
2026-ra hatályos: igen.

2026-tól az egyéni vállalkozói tb-járulék és szocho bevallása és megfizetése is negyedéves, ugyanilyen 12-ei határidővel, havi bontású 2658-as bevallásban. Ha a 12. nap nem munkanap, az általános határidő-szabály szerinti következő munkanappal kell számolni.

9. **A 112,5%-os szocho-szorzó megszűnt — HELYES**

2026. január 1-jétől az egyéni vállalkozó minimum szocho-alapja 100% minimálbér, illetve adott esetben 100% garantált bérminimum. A 112,5%-os szorzót nem kell alkalmazni.

Forrás: 2025. évi LXXXIV. törvény 27–28. §; hatálybalépés: 35. § (3). [Nemzeti Jogszabálytár – módosító törvény](https://njt.hu/jogszabaly/2025-84-00-00.5), továbbá [NAV 2026-os tájékoztató](https://nav.gov.hu/pfile/file?path=%2Fugyfeliranytu%2Fnezzen-utana%2Finf_fuz%2F2026%2F100.-Az-egyeni-vallalkozok-atalanyadozasanak-alapveto-szabalyai-2026.-01.-19)  
2026-ra hatályos: igen.

10. **„Tört hónap mindig minimálbér / 30 × napok” — TÉVES**

A helyes szabály nem egységes:

| Esemény | Minimumalap kezelése |
|---|---|
| Vállalkozás/biztosítás hónap közbeni kezdése | napi: alap `/ 30 ×` biztosítási napok |
| Vállalkozás/biztosítás hónap közbeni megszűnése | napi: alap `/ 30 ×` biztosítási napok |
| Táppénz, CSED, GYED és más törvényi kieső idő csak a hónap egy részében | napi: alap `/ 30 ×` nem mentes napok |
| Szünetelés a teljes naptári hónapban | nincs minimumalap |
| 2023. december 31. után kezdett szünetelés csak a hónap egy részében | nincs napi arányosítás: teljes havi minimumalap |
| Már 2023-ban megkezdett, 2026-ban még tartó szünetelés | átmeneti szabályként alkalmazható a régi harmincadolás |

Az „alap” itt:

- 322 800 Ft, vagy
- képesítéshez kötött főtevékenységnél 373 200 Ft.

Források:

- TB: Tbj. 40. § (3)–(5), különösen 40. § (5). [Nemzeti Jogszabálytár – Tbj.](https://njt.hu/jogszabaly/2019-122-00-00.28)
- Szocho: Szocho tv. 8. § (3)–(4), 9. §; [Nemzeti Jogszabálytár – Szocho tv.](https://njt.hu/jogszabaly/2018-52-00-00)
- NAV kifejezett 2026-os értelmezése: rész-havi szünetelésnél „nem lehet arányosítást alkalmazni”, és a minimumot a szüneteléssel érintett napokra is figyelembe kell venni. [NAV 100. információs füzet, 2026](https://nav.gov.hu/pfile/file?path=%2Fugyfeliranytu%2Fnezzen-utana%2Finf_fuz%2F2026%2F100.-Az-egyeni-vallalkozok-atalanyadozasanak-alapveto-szabalyai-2026.-01.-19)

2026-ra hatályos: igen.

### Következmény a MikroKönyv motorjára

Két eltérő számítási réteget kell külön kezelni:

1. **Göngyölt tényleges járulék-/szocho-alap:** hónapokkal számol. Az a hónap, amelyben a biztosítás akár egyetlen napig fennállt, egy teljes osztóhónapnak számít.

2. **Minimumalap:** eseményfüggő. Indulásnál és megszűnésnél naparányos, rész-havi szünetelésnél viszont főszabály szerint teljes havi.

Ezért a jelenlegi egész hónapos motor:

- hónap közbeni indulásnál/megszűnésnél hibásan túl magas minimumalapot adhat;
- a göngyölt alap osztóhónapjainál viszont helyes lehet;
- rész-havi szünetelésnél a teljes havi minimum alkalmazása helyes;
- teljes hónapos szünetelésnél nulla minimumalapot kell alkalmaznia.

Összesített minősítés: **9 HELYES, 1 TÉVES, 0 BIZONYTALAN.**
tokens used
132,575
Az ellenőrzött tíz állítás közül az 1–9. pont számszerűen helyes. A 10. pont általános szabályként TÉVES: a minimumalap napi arányosítása csak meghatározott esetekben alkalmazható, a rész-havi szünetelésre főszabály szerint nem.

Az ellenőrzés időpontja: 2026. július 18. Nemzeti Jogszabálytárban szereplő, 2026-ra hatályos szöveget és 2026-os NAV-kiadványokat használtam.

### Tételes ellenőrzés

1. **TB-járulék: 18,5% — HELYES**

A társadalombiztosítási járulék mértéke 18,5%.

Forrás: Tbj., azaz a 2019. évi CXXII. törvény 25. § (1). [Nemzeti Jogszabálytár – Tbj.](https://njt.hu/jogszabaly/2019-122-00-00.28)  
2026-ra hatályos: igen.

2. **Szocho: 13% — HELYES**

A szociális hozzájárulási adó általános mértéke az adóalap 13%-a.

Forrás: Szocho tv., azaz a 2018. évi LII. törvény 2. § (1). [Nemzeti Jogszabálytár – Szocho tv.](https://njt.hu/jogszabaly/2018-52-00-00)  
2026-ra hatályos: igen.

3. **Költséghányadok: 45%, 80%, 90% — HELYES**

A három 2026-os kulcs valóban:

- 45%: általános költséghányad;
- 80%: az Szja tv. 53. § (2)-ben felsorolt tevékenységekre;
- 90%: kizárólagos kiskereskedelmi tevékenységre, a törvényben megengedett postai tevékenységekkel.

Forrás: Szja tv. 53. §; a 45%-ot a 2025. évi LXXXIV. törvény 3. § a) pontja vezette be 2026. január 1-jével. [NAV 100. információs füzet, 2026](https://nav.gov.hu/pfile/file?path=%2Fugyfeliranytu%2Fnezzen-utana%2Finf_fuz%2F2026%2F100.-Az-egyeni-vallalkozok-atalanyadozasanak-alapveto-szabalyai-2026.-01.-19), [módosító törvény és hatálybalépés](https://njt.hu/jogszabaly/2025-84-00-00.5)  
2026-ra hatályos: igen.

Motoros figyelmeztetés: a 90% nem általában „kiskereskedelmi bevételre” alkalmazható, hanem a kizárólagossági feltétel teljesülésekor. Az év közbeni tevékenységváltás is visszahathat az alkalmazható költséghányadra.

4. **Adómentes értékhatár: 1 936 800 Ft — HELYES**

Ez az éves minimálbér fele:

`322 800 × 12 / 2 = 1 936 800 Ft`.

Fontos: ez jövedelmi, nem bevételi határ. Az átalányban megállapított jövedelem eddig a pontig adómentes. Év közbeni áttérésnél sem kell arányosítani.

Forrás: Szja tv. 1. számú melléklet 4.48.; [NAV 100. információs füzet, 2026](https://nav.gov.hu/pfile/file?path=%2Fugyfeliranytu%2Fnezzen-utana%2Finf_fuz%2F2026%2F100.-Az-egyeni-vallalkozok-atalanyadozasanak-alapveto-szabalyai-2026.-01.-19)  
2026-ra hatályos: igen.

5. **Átalányadózási bevételi értékhatár: 38 736 000 Ft — HELYES, teljes évre**

Az éves minimálbér tízszerese:

`322 800 × 12 × 10 = 38 736 000 Ft`.

Forrás: Szja tv. 50. § (1), 52. § (1); [NAV 100. információs füzet, 2026](https://nav.gov.hu/pfile/file?path=%2Fugyfeliranytu%2Fnezzen-utana%2Finf_fuz%2F2026%2F100.-Az-egyeni-vallalkozok-atalanyadozasanak-alapveto-szabalyai-2026.-01.-19)  
2026-ra hatályos: igen.

Fontos: év közbeni kezdés, megszüntetés vagy szünetelés esetén ezt a bevételi értékhatárt a tevékenység folytatásának napjaival időarányosítani kell.

6. **Kiskereskedelmi értékhatár: 193 680 000 Ft — HELYES, teljes évre**

Az éves minimálbér ötvenszerese:

`322 800 × 12 × 50 = 193 680 000 Ft`.

Forrás: Szja tv. 50. § (4), 52. § (1) b); [NAV 100. információs füzet, 2026](https://nav.gov.hu/pfile/file?path=%2Fugyfeliranytu%2Fnezzen-utana%2Finf_fuz%2F2026%2F100.-Az-egyeni-vallalkozok-atalanyadozasanak-alapveto-szabalyai-2026.-01.-19)  
2026-ra hatályos: igen.

Korlát: kizárólag kiskereskedelmi tevékenységet végző vállalkozóra vonatkozik, a törvényben külön megengedett postai közreműködői és egyéb tevékenységek kivételével. Év közbeni kezdés, megszüntetés vagy szünetelés esetén ez is időarányos.

7. **Minimálbér 322 800 Ft; garantált bérminimum 373 200 Ft — HELYES**

Forrás: 426/2025. (XII. 23.) Korm. rendelet 2. § (1)–(2). [Nemzeti Jogszabálytár – 426/2025. Korm. rendelet](https://njt.hu/jogszabaly/2025-426-20-22)  
2026-ra hatályos: igen, 2026. január 1-jétől.

A járulék- és szocho-minimumalapnál a garantált bérminimumot kell használni, ha a személyesen végzett főtevékenység legalább középfokú végzettséget vagy szakképzettséget igényel.

8. **Negyedéves adóelőleg határideje: következő hónap 12. napja — HELYES**

Az egyéni vállalkozói tevékenységhez kapcsolódó személyijövedelemadó-előleget negyedévente, a negyedévet követő hónap 12-éig kell megfizetni.

Forrás: Szja tv. 46. § (9); [NAV 100. információs füzet, 2026](https://nav.gov.hu/pfile/file?path=%2Fugyfeliranytu%2Fnezzen-utana%2Finf_fuz%2F2026%2F100.-Az-egyeni-vallalkozok-atalanyadozasanak-alapveto-szabalyai-2026.-01.-19)  
2026-ra hatályos: igen.

2026-tól az egyéni vállalkozói tb-járulék és szocho bevallása és megfizetése is negyedéves, ugyanilyen 12-ei határidővel, havi bontású 2658-as bevallásban. Ha a 12. nap nem munkanap, az általános határidő-szabály szerinti következő munkanappal kell számolni.

9. **A 112,5%-os szocho-szorzó megszűnt — HELYES**

2026. január 1-jétől az egyéni vállalkozó minimum szocho-alapja 100% minimálbér, illetve adott esetben 100% garantált bérminimum. A 112,5%-os szorzót nem kell alkalmazni.

Forrás: 2025. évi LXXXIV. törvény 27–28. §; hatálybalépés: 35. § (3). [Nemzeti Jogszabálytár – módosító törvény](https://njt.hu/jogszabaly/2025-84-00-00.5), továbbá [NAV 2026-os tájékoztató](https://nav.gov.hu/pfile/file?path=%2Fugyfeliranytu%2Fnezzen-utana%2Finf_fuz%2F2026%2F100.-Az-egyeni-vallalkozok-atalanyadozasanak-alapveto-szabalyai-2026.-01.-19)  
2026-ra hatályos: igen.

10. **„Tört hónap mindig minimálbér / 30 × napok” — TÉVES**

A helyes szabály nem egységes:

| Esemény | Minimumalap kezelése |
|---|---|
| Vállalkozás/biztosítás hónap közbeni kezdése | napi: alap `/ 30 ×` biztosítási napok |
| Vállalkozás/biztosítás hónap közbeni megszűnése | napi: alap `/ 30 ×` biztosítási napok |
| Táppénz, CSED, GYED és más törvényi kieső idő csak a hónap egy részében | napi: alap `/ 30 ×` nem mentes napok |
| Szünetelés a teljes naptári hónapban | nincs minimumalap |
| 2023. december 31. után kezdett szünetelés csak a hónap egy részében | nincs napi arányosítás: teljes havi minimumalap |
| Már 2023-ban megkezdett, 2026-ban még tartó szünetelés | átmeneti szabályként alkalmazható a régi harmincadolás |

Az „alap” itt:

- 322 800 Ft, vagy
- képesítéshez kötött főtevékenységnél 373 200 Ft.

Források:

- TB: Tbj. 40. § (3)–(5), különösen 40. § (5). [Nemzeti Jogszabálytár – Tbj.](https://njt.hu/jogszabaly/2019-122-00-00.28)
- Szocho: Szocho tv. 8. § (3)–(4), 9. §; [Nemzeti Jogszabálytár – Szocho tv.](https://njt.hu/jogszabaly/2018-52-00-00)
- NAV kifejezett 2026-os értelmezése: rész-havi szünetelésnél „nem lehet arányosítást alkalmazni”, és a minimumot a szüneteléssel érintett napokra is figyelembe kell venni. [NAV 100. információs füzet, 2026](https://nav.gov.hu/pfile/file?path=%2Fugyfeliranytu%2Fnezzen-utana%2Finf_fuz%2F2026%2F100.-Az-egyeni-vallalkozok-atalanyadozasanak-alapveto-szabalyai-2026.-01.-19)

2026-ra hatályos: igen.

### Következmény a MikroKönyv motorjára

Két eltérő számítási réteget kell külön kezelni:

1. **Göngyölt tényleges járulék-/szocho-alap:** hónapokkal számol. Az a hónap, amelyben a biztosítás akár egyetlen napig fennállt, egy teljes osztóhónapnak számít.

2. **Minimumalap:** eseményfüggő. Indulásnál és megszűnésnél naparányos, rész-havi szünetelésnél viszont főszabály szerint teljes havi.

Ezért a jelenlegi egész hónapos motor:

- hónap közbeni indulásnál/megszűnésnél hibásan túl magas minimumalapot adhat;
- a göngyölt alap osztóhónapjainál viszont helyes lehet;
- rész-havi szünetelésnél a teljes havi minimum alkalmazása helyes;
- teljes hónapos szünetelésnél nulla minimumalapot kell alkalmaznia.

Összesített minősítés: **9 HELYES, 1 TÉVES, 0 BIZONYTALAN.**
