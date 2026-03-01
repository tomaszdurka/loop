export default function Risks() {
  const risks = [
    {
      title: "Czas trwania postępowania",
      description: "Sprawy sądowe mogą trwać 12-36 miesięcy w zależności od obciążenia sądów i skomplikowania sprawy.",
      level: "medium"
    },
    {
      title: "Konieczność spłaty kapitału",
      description: "W przypadku unieważnienia umowy należy zwrócić bankowi wykorzystany kapitał kredytu (bez odsetek).",
      level: "high"
    },
    {
      title: "Ryzyko apelacji banku",
      description: "Bank może odwołać się od niekorzystnego wyroku, co wydłuży postępowanie o kolejne 12-18 miesięcy.",
      level: "medium"
    },
    {
      title: "Możliwa utrata zdolności kredytowej",
      description: "Podczas trwania sporu możesz mieć ograniczoną zdolność do zaciągania nowych kredytów.",
      level: "low"
    },
    {
      title: "Wpis do BIK",
      description: "Jeśli zdecydujesz się na zawieszenie spłat podczas procesu, może to wpłynąć na Twoją historię kredytową.",
      level: "high"
    }
  ];

  const mitigations = [
    "Pracujemy z doświadczonymi prawnikami specjalizującymi się w kredytach frankowych",
    "Analizujemy każdą sprawę indywidualnie i informujemy o rzeczywistych szansach",
    "Rozliczenie finansowe następuje dopiero po wygranej (success fee)",
    "Pomagamy w planowaniu finansowym na wypadek konieczności zwrotu kapitału",
    "Oferujemy pełną transparentność na każdym etapie postępowania"
  ];

  const levelColors = {
    low: "bg-yellow-50 border-yellow-200 text-yellow-900",
    medium: "bg-orange-50 border-orange-200 text-orange-900",
    high: "bg-red-50 border-red-200 text-red-900"
  };

  const levelLabels = {
    low: "Niskie ryzyko",
    medium: "Średnie ryzyko",
    high: "Wysokie ryzyko"
  };

  return (
    <div className="bg-slate-50 rounded-3xl p-8 md:p-12">
      <div className="text-center mb-10">
        <h2 className="text-3xl md:text-4xl font-bold text-slate-900 mb-4">
          Ryzyka i ograniczenia
        </h2>
        <p className="text-lg text-slate-600 max-w-3xl mx-auto">
          Dbamy o pełną transparentność. Oto najważniejsze ryzyka związane z procesem
          unieważnienia kredytu frankowego.
        </p>
      </div>

      {/* Risks list */}
      <div className="space-y-4 mb-10">
        {risks.map((risk, index) => (
          <div
            key={index}
            className={`border rounded-xl p-6 ${levelColors[risk.level]}`}
          >
            <div className="flex items-start justify-between gap-4 mb-2">
              <h3 className="text-lg font-bold flex-1">{risk.title}</h3>
              <span className="text-xs font-semibold uppercase tracking-wide px-3 py-1 rounded-full bg-white/50">
                {levelLabels[risk.level]}
              </span>
            </div>
            <p className="text-sm leading-relaxed">{risk.description}</p>
          </div>
        ))}
      </div>

      {/* Mitigations */}
      <div className="bg-white rounded-xl p-8 shadow-sm border border-slate-200">
        <h3 className="text-xl font-bold text-slate-900 mb-6">
          Jak minimalizujemy ryzyka?
        </h3>
        <ul className="space-y-3">
          {mitigations.map((mitigation, index) => (
            <li key={index} className="flex items-start gap-3">
              <span className="flex-shrink-0 w-6 h-6 rounded-full bg-blue-100 text-blue-600 flex items-center justify-center text-sm font-bold">
                ✓
              </span>
              <span className="text-slate-700">{mitigation}</span>
            </li>
          ))}
        </ul>
      </div>

      <div className="mt-8 p-6 bg-slate-800 text-white rounded-xl">
        <p className="text-sm leading-relaxed">
          <strong>⚖️ Ważna informacja prawna:</strong> Decyzja o wystąpieniu na drogę sądową
          powinna być podjęta po dokładnej analizie Twojej sytuacji finansowej i prawnej.
          Oferujemy bezpłatną konsultację, podczas której przedstawimy Ci szczegółową ocenę
          ryzyka dla Twojej konkretnej sprawy.
        </p>
      </div>
    </div>
  );
}
